import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Markdown, type OverlayHandle, Input as PiInput, Text, type TUI } from "@mariozechner/pi-tui";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { buildEnvironmentReminder } from "../agent/system-prompt.js";
import { toolActionLabel, toolActionPast } from "../ui/tool-labels.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { ansi, markdownTheme, roleColor } from "./theme.js";

/**
 * Root pi-tui component. Mirrors ink/App.tsx in responsibilities — agent
 * bundle lifecycle, transcript display, input, status bar — but expressed
 * as a Container with imperatively-managed children rather than a React
 * tree. Agent events flow in via bundle.subscribe and mutate the
 * children directly; pi-tui's line-diff renderer handles the redraw.
 */
export class App extends Container {
	private readonly bundle: AgentBundle;
	private readonly transcript: TranscriptView;
	private readonly statusBar: StatusBar;
	private readonly inputBar: PiInput;
	private readonly unsubscribe: () => void;
	private exitResolve: (() => void) | undefined;
	private readonly exitPromise: Promise<void>;
	private exitArmedAt = 0;
	private busy = false;
	private streamingMessage: AgentMessage | undefined;
	private removeInputListener: (() => void) | undefined;
	private permissionOverlay: { handle: OverlayHandle; component: PermissionOverlay } | undefined;
	private removePermSubscription: (() => void) | undefined;
	private tui: TUI | undefined;
	/** Has the env reminder been prepended to a turn this session yet? */
	private envInjected = false;

	constructor() {
		super();
		this.bundle = createAgent({ resume: process.env.CODEBASE_FRESH !== "1" });
		this.exitPromise = new Promise<void>((resolve) => {
			this.exitResolve = resolve;
		});

		// If we resumed, the saved transcript already includes env context
		// from the prior session — don't re-inject on first turn.
		if (this.bundle.resumedMessages.length > 0) this.envInjected = true;

		this.transcript = new TranscriptView(this.bundle.resumedMessages);
		this.statusBar = new StatusBar(this.bundle.model.name);
		this.inputBar = new PiInput();
		this.inputBar.onSubmit = (text) => {
			this.inputBar.setValue("");
			this.inputBar.invalidate();
			void this.handleSubmit(text);
		};

		this.addChild(new WelcomeBanner(this.bundle.model.name));
		this.addChild(this.transcript);
		this.addChild(this.statusBar);
		this.addChild(this.inputBar);

		this.unsubscribe = this.bundle.subscribe((event) => this.handleAgentEvent(event));
	}

	/**
	 * Called by runtime after the App is added to the TUI. Lets us hook
	 * the input listener for Ctrl-C and grab focus for the Editor —
	 * neither of which we can do from the constructor because we don't
	 * have a TUI reference yet.
	 */
	attachToTui(tui: TUI): void {
		this.tui = tui;
		tui.setFocus(this.inputBar);
		this.removeInputListener = tui.addInputListener((data) => this.handleGlobalInput(data));
		// Permission requests arrive asynchronously from tool execution.
		// Show the overlay when a request lands; dismiss when answered.
		this.removePermSubscription = this.bundle.permissions.subscribe((req) => {
			if (req) this.showPermissionOverlay(req);
			else this.hidePermissionOverlay();
		});
	}

	private showPermissionOverlay(req: import("../permissions/store.js").PermissionRequest): void {
		if (!this.tui) return;
		this.hidePermissionOverlay();
		const component = new PermissionOverlay(req, (choice) => {
			this.bundle.permissions.respond(req.id, choice);
		});
		const handle = this.tui.showOverlay(component, {
			anchor: "center",
			width: "70%",
			minWidth: 50,
		});
		this.tui.setFocus(component.getFocusTarget());
		this.permissionOverlay = { handle, component };
	}

	private hidePermissionOverlay(): void {
		if (!this.permissionOverlay) return;
		this.permissionOverlay.handle.hide();
		this.permissionOverlay = undefined;
		// Return focus to the editor when the overlay closes.
		this.tui?.setFocus(this.inputBar);
	}

	waitForExit(): Promise<void> {
		return this.exitPromise;
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		// Ctrl-C: first press aborts the agent if busy + arms a 1s exit
		// window; second press within that window exits. We mark consume
		// only when we want to suppress the keystroke from reaching the
		// focused input (the abort case), so the editor's own Ctrl-C
		// handling stays out of our way.
		if (data === "\x03") {
			const now = Date.now();
			if (now - this.exitArmedAt < 1000) {
				this.exitResolve?.();
				return { consume: true };
			}
			this.exitArmedAt = now;
			if (this.busy) {
				try {
					this.bundle.agent.abort();
				} catch {
					// Already settling — fine.
				}
				return { consume: true };
			}
			// Idle: let the editor handle Ctrl-C (it clears the buffer if
			// there's text). The exit window stays armed for the next press.
			return undefined;
		}
		return undefined;
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Inject env on the first agent turn of a fresh session so the
		// model sees cwd / git / date. Stays out of the system prompt to
		// keep the prompt cache intact.
		let promptText = trimmed;
		if (!this.envInjected) {
			promptText = `${buildEnvironmentReminder(this.bundle.toolContext.cwd)}\n\n${trimmed}`;
			this.envInjected = true;
		}
		this.transcript.appendUserMessage(trimmed);
		this.bundle.agent.prompt(promptText).catch(() => {
			// Errors are surfaced via the message_end / agent_end event path;
			// the .prompt() promise's own rejection isn't useful here.
		});
	}

	private handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.statusBar.setStatus("thinking");
				break;
			case "turn_start":
				this.statusBar.setStatus("thinking");
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.transcript.setStreaming(event.message);
					this.statusBar.setStatus("writing");
				}
				break;
			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.transcript.setStreaming(event.message);
				}
				break;
			case "message_end":
				if (event.message.role !== "user") {
					this.transcript.appendMessage(event.message);
					this.streamingMessage = undefined;
					this.transcript.setStreaming(undefined);
				}
				break;
			case "tool_execution_start":
				this.statusBar.setStatus(`tool: ${event.toolName}`);
				break;
			case "tool_execution_end":
				this.statusBar.setStatus("thinking");
				break;
			case "turn_end":
				this.statusBar.setStatus("thinking");
				break;
			case "agent_end":
				this.busy = false;
				this.statusBar.setStatus("idle");
				break;
		}
	}

	dispose(): void {
		this.removeInputListener?.();
		this.removePermSubscription?.();
		this.hidePermissionOverlay();
		this.unsubscribe();
	}
}

/** Static one-line banner — only renders once at the top of the transcript. */
class WelcomeBanner extends Container {
	constructor(modelName: string) {
		super();
		this.addChild(new Text(`codebase · ${modelName}`, 1, 0));
		this.addChild(new Text("(pi-tui · phase 1)", 1, 0));
	}
}

/**
 * Bottom-of-screen status bar showing the current agent state. Phase 1
 * keeps this simple — just the state label. Tok/s, ctx %, cost, model
 * indicator come in phase 3.
 */
class StatusBar extends Container {
	private readonly line: Text;
	private readonly modelName: string;
	constructor(modelName: string) {
		super();
		this.modelName = modelName;
		this.line = new Text(this.format("idle"), 1, 0);
		this.addChild(this.line);
	}
	setStatus(status: string): void {
		this.line.setText(this.format(status));
		this.line.invalidate();
	}
	private format(status: string): string {
		return `[${status}] · ${this.modelName}`;
	}
}

/**
 * Append-only transcript display + an optional in-flight streaming pane.
 * Each finalized message becomes a fixed child (renders once via pi-tui's
 * line-diff); the streaming message swaps in/out as a separate child
 * that gets invalidated per event.
 */
class TranscriptView extends Container {
	private readonly history: Container;
	private streamingChild: Container | undefined;

	constructor(initialMessages: AgentMessage[] = []) {
		super();
		this.history = new Container();
		this.addChild(this.history);
		for (const m of initialMessages) {
			this.history.addChild(renderMessage(m));
		}
	}

	appendUserMessage(text: string): void {
		this.history.addChild(renderMessage({ role: "user", content: text, timestamp: Date.now() } as AgentMessage));
		this.history.invalidate();
	}

	appendMessage(message: AgentMessage): void {
		this.history.addChild(renderMessage(message));
		this.history.invalidate();
	}

	setStreaming(message: AgentMessage | undefined): void {
		if (this.streamingChild) {
			this.removeStreaming();
		}
		if (!message) return;
		this.streamingChild = renderMessage(message, true);
		this.addChild(this.streamingChild);
		this.invalidate();
	}

	private removeStreaming(): void {
		if (!this.streamingChild) return;
		// Container's removeChild is via the children array — pi-tui doesn't
		// expose removeChild publicly on Container, so we recreate by
		// invalidating after dropping the reference. The next render will
		// pull the updated child list.
		const children = (this as unknown as { children: unknown[] }).children;
		if (Array.isArray(children)) {
			const idx = children.indexOf(this.streamingChild as unknown);
			if (idx >= 0) children.splice(idx, 1);
		}
		this.streamingChild = undefined;
		this.invalidate();
	}
}

/**
 * Render one message as a Container with a role-colored header + body.
 * Assistant text content goes through pi-tui's Markdown so code blocks,
 * lists, links etc. render properly. Tool calls render via the
 * toolActionLabel/toolActionPast helpers from the ink path so the
 * surface text is identical (e.g. "Reading src/x.ts").
 *
 * `streaming` toggles the "…" suffix on the role label and uses the
 * present-tense verb form for tool calls.
 */
function renderMessage(message: AgentMessage, streaming = false): Container {
	const c = new Container();
	const role = message.role as string;
	const labelText =
		role === "user" ? "you" : role === "assistant" ? "codebase" : role === "toolResult" ? "tool" : role;
	const colorFn = roleColor[role as keyof typeof roleColor] ?? ((s: string) => s);
	const header = `${colorFn(ansi.bold(labelText))}${streaming ? ansi.dim(" …") : ""}`;
	c.addChild(new Text(header, 1, 0));

	if (typeof message.content === "string") {
		if (message.content) c.addChild(new Text(message.content, 1, 0));
		return c;
	}
	if (!Array.isArray(message.content)) return c;
	for (const block of message.content) {
		const b = block as { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
		if (b.type === "text" && typeof b.text === "string") {
			// Markdown for assistant content (code blocks, lists, links).
			// For user/toolResult text, plain Text avoids style surprises.
			if (role === "assistant") {
				c.addChild(new Markdown(b.text, 1, 0, markdownTheme));
			} else {
				c.addChild(new Text(b.text, 1, 0));
			}
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			c.addChild(new Text(ansi.dim(ansi.italic(`(thinking) ${b.thinking}`)), 1, 0));
		} else if (b.type === "toolCall" && typeof b.name === "string") {
			const label = streaming ? toolActionLabel(b.name, b.arguments) : toolActionPast(b.name, b.arguments);
			const glyph = streaming ? ansi.magenta("…") : ansi.magenta("✓");
			c.addChild(new Text(`${glyph} ${ansi.magenta(label)}`, 1, 0));
		}
	}
	return c;
}
