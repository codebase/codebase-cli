import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Markdown,
	type OverlayHandle,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { buildEnvironmentReminder } from "../agent/system-prompt.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { CommandRegistry } from "../commands/registry.js";
import type { ChatState, ToolExecution } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { buildAttachmentPrompt, collectAttachments } from "../ui/attachments.js";
import { HistoryStore } from "../ui/history-store.js";
import { runShellEscape } from "../ui/shell-escape.js";
import { toolActionLabel, toolActionPast } from "../ui/tool-labels.js";
import { BackgroundShellPanel } from "./background-shell-panel.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { ansi, editorTheme, markdownTheme, roleColor } from "./theme.js";
import { UserQueryOverlay } from "./user-query-overlay.js";

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
	private inputBar: Editor | undefined;
	private readonly bgShellPanel: BackgroundShellPanel;
	private readonly registry: CommandRegistry;
	private readonly historyStore: HistoryStore;
	private readonly unsubscribe: () => void;
	private exitResolve: (() => void) | undefined;
	private readonly exitPromise: Promise<void>;
	private exitArmedAt = 0;
	private busy = false;
	private streamingMessage: AgentMessage | undefined;
	private removeInputListener: (() => void) | undefined;
	private permissionOverlay: { handle: OverlayHandle; component: PermissionOverlay } | undefined;
	private userQueryOverlay: { handle: OverlayHandle; component: UserQueryOverlay } | undefined;
	private removePermSubscription: (() => void) | undefined;
	private removeUserQuerySubscription: (() => void) | undefined;
	private tui: TUI | undefined;
	/** Shadow state — the subset of ChatState our slash commands actually read. */
	private readonly messages: AgentMessage[] = [];
	private readonly tools = new Map<string, ToolExecution>();
	private status: ChatState["status"] = "idle";
	private usage = EMPTY_USAGE;
	/** Prompts typed while busy; drained one-at-a-time when the agent goes idle. */
	private queuedPrompts: string[] = [];
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
		this.messages.push(...this.bundle.resumedMessages);

		this.transcript = new TranscriptView(this.bundle.resumedMessages);
		this.statusBar = new StatusBar(this.bundle.model.name);
		this.bgShellPanel = new BackgroundShellPanel(this.bundle.backgroundShells);
		this.historyStore = new HistoryStore({ cwd: this.bundle.toolContext.cwd });

		this.registry = new CommandRegistry();
		this.registry.registerAll(BUILTIN_COMMANDS);

		this.addChild(new WelcomeBanner(this.bundle.model.name));
		this.addChild(this.transcript);
		this.addChild(this.bgShellPanel);
		this.addChild(this.statusBar);

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

		// Editor requires the TUI ref at construction; create it lazily here
		// and slot it in below the status bar so the layout matches the
		// ink-era SmartInput position.
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });
		editor.onSubmit = (text) => {
			editor.setText("");
			editor.invalidate();
			if (text.trim()) editor.addToHistory(text);
			void this.handleSubmit(text);
		};
		// Seed pi-tui's in-memory history ring from disk so ↑/↓ recall
		// works across restarts.
		for (const entry of this.historyStore.load()) editor.addToHistory(entry);
		// Slash-command + @path autocomplete. Built-ins are kept in sync via
		// registry.list() so any newly-registered command shows up without
		// extra wiring. File completion is provided by the combined helper
		// (uses fd if available, otherwise readdir-walks the cwd).
		const slashItems: AutocompleteItem[] = this.registry.list().map((cmd) => ({
			value: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description,
		}));
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashItems, this.bundle.toolContext.cwd));
		this.inputBar = editor;
		this.addChild(editor);
		tui.setFocus(editor);
		this.removeInputListener = tui.addInputListener((data) => this.handleGlobalInput(data));
		// Permission + UserQuery requests arrive asynchronously from tool
		// execution. Show the overlay when one lands; dismiss when answered.
		this.removePermSubscription = this.bundle.permissions.subscribe((req) => {
			if (req) this.showPermissionOverlay(req);
			else this.hidePermissionOverlay();
		});
		this.removeUserQuerySubscription = this.bundle.userQueries.subscribe((q) => {
			if (q) this.showUserQueryOverlay(q);
			else this.hideUserQueryOverlay();
		});
	}

	private showUserQueryOverlay(q: import("../user-queries/store.js").UserQuery): void {
		if (!this.tui) return;
		this.hideUserQueryOverlay();
		const component = new UserQueryOverlay(
			q,
			(answer) => this.bundle.userQueries.respond(q.id, answer),
			() => this.bundle.userQueries.cancel(q.id),
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 50 });
		this.tui.setFocus(component.getFocusTarget());
		this.userQueryOverlay = { handle, component };
	}

	private hideUserQueryOverlay(): void {
		if (!this.userQueryOverlay) return;
		this.userQueryOverlay.handle.hide();
		this.userQueryOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
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
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
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

		// Slash commands and `!cmd` shell escapes bypass the agent and the
		// type-ahead queue. They run immediately so the user never has to
		// wait for a turn to finish before, say, /help or !git status.
		if (trimmed.startsWith("/")) {
			await this.dispatchSlash(trimmed);
			this.persistHistory(trimmed);
			return;
		}
		if (trimmed.startsWith("!") && trimmed.length > 1) {
			const cmd = trimmed.slice(1);
			await runShellEscape(cmd, this.bundle.toolContext.cwd, (line) => this.statusBar.note(line));
			this.persistHistory(trimmed);
			return;
		}

		// Mid-turn typing: agent is busy → queue the prompt for after the
		// current turn ends. Drained automatically when status flips back
		// to idle.
		if (this.busy) {
			this.queuedPrompts.push(trimmed);
			const preview = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
			this.statusBar.note(`↩ queued (${this.queuedPrompts.length}): ${preview}`);
			return;
		}

		// `@path` tokens auto-attach file contents to the prompt so the
		// user doesn't have to spend a tool turn just to put a file in
		// context.
		const attachments = collectAttachments(trimmed, this.bundle.toolContext.cwd);
		const augmented = attachments.length > 0 ? buildAttachmentPrompt(trimmed, attachments) : trimmed;
		if (attachments.length > 0) {
			this.statusBar.note(`Attached: ${attachments.map((a) => a.relPath).join(", ")}`);
		}

		let promptText = augmented;
		if (!this.envInjected) {
			promptText = `${buildEnvironmentReminder(this.bundle.toolContext.cwd)}\n\n${augmented}`;
			this.envInjected = true;
		}
		const userMsg: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
		this.messages.push(userMsg);
		this.transcript.appendUserMessage(trimmed);
		this.persistHistory(trimmed);
		this.bundle.agent.prompt(promptText).catch(() => {
			// Errors surface via agent_end with errorMessage; rejection here isn't useful.
		});
	}

	/**
	 * Persist a successfully-submitted line to disk-backed history. The
	 * Editor's in-memory ring already gets the entry via its onSubmit path;
	 * this is the cross-session companion.
	 */
	private persistHistory(line: string): void {
		this.historyStore.append(line);
	}

	private async dispatchSlash(text: string): Promise<void> {
		const result = await this.registry.dispatch(text, {
			bundle: this.bundle,
			state: this.buildChatStateShadow(),
			emit: (line) => this.statusBar.note(line),
			clearDisplay: () => {
				this.transcript.clear();
				this.messages.length = 0;
			},
			exit: () => this.exitResolve?.(),
			registry: this.registry,
			switchModel: async () => {
				// Hot-swap not yet implemented in pi-tui path. Phase 4 item.
				this.statusBar.note("/model switching not yet implemented on the pi-tui path");
			},
			openModelPicker: () => {
				this.statusBar.note("model picker not yet implemented on the pi-tui path");
			},
		});
		if (!result.handled) {
			this.statusBar.note(`unknown command: ${text.split(/\s/)[0]}`);
		}
	}

	private buildChatStateShadow(): ChatState {
		return {
			messages: [...this.messages],
			tools: new Map(this.tools),
			status: this.status,
			usage: this.usage,
			model: {
				provider: this.bundle.model.provider,
				id: this.bundle.model.id,
				name: this.bundle.model.name,
			},
		};
	}

	private maybeDrainQueue(): void {
		if (this.busy || this.queuedPrompts.length === 0) return;
		const next = this.queuedPrompts.shift();
		if (next) void this.handleSubmit(next);
	}

	private handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.status = "thinking";
				this.statusBar.setStatus("thinking");
				break;
			case "turn_start":
				this.status = "thinking";
				this.statusBar.setStatus("thinking");
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.status = "streaming";
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
					this.messages.push(event.message);
					this.transcript.appendMessage(event.message);
					this.streamingMessage = undefined;
					this.transcript.setStreaming(undefined);
					if ("usage" in event.message && event.message.usage) {
						this.usage = mergeUsage(this.usage, event.message.usage);
					}
				}
				break;
			case "tool_execution_start": {
				this.status = "tool";
				const exec: ToolExecution = {
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					status: "running",
					startedAt: Date.now(),
				};
				this.tools.set(exec.id, exec);
				this.statusBar.setStatus(`tool: ${event.toolName}`);
				break;
			}
			case "tool_execution_update": {
				const existing = this.tools.get(event.toolCallId);
				if (existing) {
					this.tools.set(event.toolCallId, { ...existing, result: stringifyResult(event.partialResult) });
				}
				break;
			}
			case "tool_execution_end": {
				const existing = this.tools.get(event.toolCallId);
				if (existing) {
					this.tools.set(event.toolCallId, {
						...existing,
						status: event.isError ? "error" : "done",
						endedAt: Date.now(),
						result: stringifyResult(event.result),
						error: event.isError ? stringifyResult(event.result) : undefined,
					});
				}
				this.statusBar.setStatus("thinking");
				break;
			}
			case "turn_end":
				this.status = "thinking";
				this.statusBar.setStatus("thinking");
				break;
			case "agent_end":
				this.busy = false;
				this.status = "idle";
				this.statusBar.setStatus("idle");
				this.maybeDrainQueue();
				break;
		}
	}

	dispose(): void {
		this.removeInputListener?.();
		this.removePermSubscription?.();
		this.removeUserQuerySubscription?.();
		this.hidePermissionOverlay();
		this.hideUserQueryOverlay();
		this.bgShellPanel.dispose();
		this.bundle.backgroundShells.killAllSync();
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
	private readonly notes: Text;
	private readonly modelName: string;
	private currentStatus = "idle";
	constructor(modelName: string) {
		super();
		this.modelName = modelName;
		this.line = new Text(this.format(this.currentStatus), 1, 0);
		this.notes = new Text("", 1, 0);
		this.addChild(this.notes);
		this.addChild(this.line);
	}
	setStatus(status: string): void {
		this.currentStatus = status;
		this.line.setText(this.format(status));
		this.line.invalidate();
	}
	/** Display a one-shot note above the status row (e.g. "Attached: x.ts", queue events). */
	note(line: string): void {
		this.notes.setText(line);
		this.notes.invalidate();
	}
	private format(status: string): string {
		return `${ansi.dim("[")}${status}${ansi.dim("]")} · ${this.modelName}`;
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

	clear(): void {
		// /clear handler: wipe the visible transcript. Recreate the child
		// list by mutating the internal array — Container doesn't expose a
		// removeChild today.
		const hist = this.history as unknown as { children: unknown[] };
		hist.children = [];
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
function mergeUsage(a: typeof EMPTY_USAGE, b: typeof EMPTY_USAGE): typeof EMPTY_USAGE {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

function stringifyResult(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

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
