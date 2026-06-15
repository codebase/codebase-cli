import { appendFileSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type OverlayHandle,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { CHARS_PER_TOKEN, estimateContextTokens, streamingChars } from "../agent/context-estimate.js";
import { listRewindPoints, type RewindPoint, truncateBefore } from "../agent/conversation-rewind.js";
import { generateSuggestion } from "../agent/prompt-suggestion.js";
import { routeUserInput } from "../agent/router.js";
import { buildEnvironmentReminder } from "../agent/system-prompt.js";
import {
	type BranchSpec,
	cleanupTournament,
	mergeWinner,
	runTournament,
	type TournamentOutcome,
	type TournamentProgress,
} from "../agent/tournament.js";
import { createContestantRunner, defaultContestantPrompt } from "../agent/tournament-runner.js";
import { snapshotWorkingTree } from "../agent/wip-snapshot.js";
import { copyToClipboard } from "../clipboard/copy.js";
import { BUILTIN_COMMANDS } from "../commands/builtins/index.js";
import { buildMcpPromptCommands } from "../commands/mcp-prompt-commands.js";
import { CommandRegistry } from "../commands/registry.js";
import { buildSkillCommands } from "../commands/skill-commands.js";
import { ConfigStore } from "../config/store.js";
import { quickAddMemory } from "../memory/quick-add.js";
import { runPlanFlow } from "../plan/run-flow.js";
import type { ChatState, ToolExecution } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { buildAttachmentPrompt, collectAttachments } from "../ui/attachments.js";
import { type ClipboardImage, readClipboardImage } from "../ui/clipboard-image.js";
import { editInExternalEditor } from "../ui/external-editor.js";
import { HistoryStore } from "../ui/history-store.js";
import { notifyTurnComplete } from "../ui/notify.js";
import { runShellEscape } from "../ui/shell-escape.js";
import { setTerminalTitle } from "../ui/terminal-title.js";
import { pickNextVerb, THINKING_VERBS } from "../ui/thinking-verbs.js";
import { BackgroundShellPanel } from "./background-shell-panel.js";
import { ContextWarning, ErrorCard } from "./banners.js";
import { CompactionBanner } from "./compaction-banner.js";
import { CopyPickerOverlay } from "./copy-picker-overlay.js";
import { CopyRegistry } from "./copy-targets.js";
import { HistorySearchOverlay } from "./history-search-overlay.js";
import { buildMessageBlocks, type CopyBoxOptions, type MessageKind, MessageView } from "./message-view.js";
import { type ModelOption, ModelPickerOverlay } from "./model-picker-overlay.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { RewindOverlay } from "./rewind-overlay.js";
import { SuggestionLine } from "./suggestion-line.js";
import { TaskPanel } from "./task-panel.js";
import { ansi, editorTheme } from "./theme.js";
import { LiveToolPanel } from "./tool-panel-live.js";
import { TournamentOverlay } from "./tournament-overlay.js";
import { UserQueryOverlay } from "./user-query-overlay.js";
import { WelcomeBanner } from "./welcome.js";

/**
 * Root pi-tui component. Mirrors ink/App.tsx in responsibilities — agent
 * bundle lifecycle, transcript display, input, status bar — but expressed
 * as a Container with imperatively-managed children rather than a React
 * tree. Agent events flow in via bundle.subscribe and mutate the
 * children directly; pi-tui's line-diff renderer handles the redraw.
 */
export class App extends Container {
	private bundle: AgentBundle;
	private readonly transcript: TranscriptView;
	private readonly statusBar: StatusBar;
	private inputBar: Editor | undefined;
	private readonly bgShellPanel: BackgroundShellPanel;
	private readonly compactionBanner: CompactionBanner;
	private readonly taskPanel: TaskPanel;
	private readonly errorCard: ErrorCard;
	private readonly contextWarning: ContextWarning;
	private readonly liveToolPanel: LiveToolPanel;
	private readonly registry: CommandRegistry;
	private readonly historyStore: HistoryStore;
	private unsubscribe: () => void;
	private exitResolve: (() => void) | undefined;
	private readonly exitPromise: Promise<void>;
	private exitArmedAt = 0;
	private busy = false;
	private streamingMessage: AgentMessage | undefined;
	private removeInputListener: (() => void) | undefined;
	private permissionOverlay: { handle: OverlayHandle; component: PermissionOverlay } | undefined;
	private userQueryOverlay: { handle: OverlayHandle; component: UserQueryOverlay } | undefined;
	private modelPickerOverlay: { handle: OverlayHandle; component: ModelPickerOverlay } | undefined;
	private historySearchOverlay: { handle: OverlayHandle; component: HistorySearchOverlay } | undefined;
	private rewindOverlay: { handle: OverlayHandle; component: RewindOverlay } | undefined;
	private tournamentOverlay: { handle: OverlayHandle; component: TournamentOverlay } | undefined;
	private tournamentRunning = false;
	private tournamentAbort: AbortController | undefined;
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
	/** Count of assistant messages emitted during the current agent turn. Reset on agent_start. */
	private assistantMessagesThisTurn = 0;
	/** Epoch ms when the current turn began — drives the completion notification. */
	private turnStartedAt = 0;
	/** Has the env reminder been prepended to a turn this session yet? */
	private envInjected = false;
	/** Last reported turn usage from pi-ai — feeds the ctx-bar via estimateContextTokens. */
	private turnUsage: ChatState["turnUsage"];
	/** Streaming-rate sampler — interval ticker that recalculates tok/s. */
	private rateTimer: NodeJS.Timeout | undefined;
	private rateSamples: Array<{ t: number; c: number }> = [];
	/** Spinner timer — drives the status-bar throbber + per-tool-call spinners while busy. */
	private spinnerTimer: NodeJS.Timeout | undefined;
	/** Tracks bg-shell status transitions so we only notify the model once per exit. */
	private bgShellPrevStatus = new Map<string, string>();
	private removeBgShellSubscription: (() => void) | undefined;
	/** Ghost prompt suggestion shown above the editor when the agent is idle. */
	private readonly suggestionLine = new SuggestionLine();
	private suggestionTimer: NodeJS.Timeout | undefined;
	private suggestionAbort: AbortController | undefined;
	/** Keyboard copy mode: registry of transcript copy boxes + the Ctrl-O picker. */
	private readonly copyRegistry = new CopyRegistry();
	private copyPickerOverlay: { handle: OverlayHandle; component: CopyPickerOverlay } | undefined;
	/** Images pulled off the clipboard with Ctrl-V, attached to the next prompt. */
	private pendingImages: ClipboardImage[] = [];

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

		this.transcript = new TranscriptView(this.bundle.resumedMessages, this.tools, this.copyRegistry);
		// Async store subscribers need to schedule a TUI render after every
		// state change — pi-tui only paints on input events or explicit
		// requestRender, never automatically on child invalidate.
		const requestRender = (): void => this.tui?.requestRender();
		this.statusBar = new StatusBar(
			this.bundle.model.name,
			this.bundle.toolContext.cwd,
			requestRender,
			this.bundle.source !== "proxy",
		);
		this.bgShellPanel = new BackgroundShellPanel(this.bundle.backgroundShells, requestRender);
		this.compactionBanner = new CompactionBanner(this.bundle.compactionMonitor, requestRender);
		this.taskPanel = new TaskPanel(this.bundle.toolContext.tasks, requestRender);
		this.errorCard = new ErrorCard();
		this.contextWarning = new ContextWarning();
		this.liveToolPanel = new LiveToolPanel(this.tools);
		this.historyStore = new HistoryStore({ cwd: this.bundle.toolContext.cwd });

		this.registry = new CommandRegistry();
		this.registry.registerAll(BUILTIN_COMMANDS);

		this.addChild(
			new WelcomeBanner({
				modelName: this.bundle.model.name,
				source: this.bundle.source,
				cwd: this.bundle.toolContext.cwd,
				resumedFrom: this.bundle.resumedFrom,
			}),
		);
		this.addChild(this.transcript);
		this.addChild(this.compactionBanner);
		this.addChild(this.taskPanel);
		this.addChild(this.errorCard);
		this.addChild(this.contextWarning);
		this.addChild(this.liveToolPanel);
		this.addChild(this.bgShellPanel);
		this.addChild(this.suggestionLine);
		this.addChild(this.statusBar);

		// Async handler so the event loop can yield between events — pi-tui's
		// timer + render scheduler need microtask gaps to fire. Without `async`
		// here, a burst of agent events drains the microtask queue without
		// letting setTimeout-driven renders or interval-driven spinners ever
		// run, and the user sees nothing until they press a key.
		this.unsubscribe = this.bundle.subscribe(async (event) => {
			debugLog(`event=${event.type} tui=${!!this.tui} busy=${this.busy} spinnerTimer=${!!this.spinnerTimer}`);
			this.handleAgentEvent(event);
		});
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
		this.setTitle(false);
		// Permission + UserQuery requests arrive asynchronously from tool
		// execution. Show the overlay when one lands; dismiss when answered.
		// Pi-tui needs an explicit requestRender after async state changes
		// (see handleAgentEvent for the rationale).
		this.removePermSubscription = this.bundle.permissions.subscribe((req) => {
			if (req) this.showPermissionOverlay(req);
			else this.hidePermissionOverlay();
			this.tui?.requestRender();
		});
		this.removeUserQuerySubscription = this.bundle.userQueries.subscribe((q) => {
			if (q) this.showUserQueryOverlay(q);
			else this.hideUserQueryOverlay();
			this.tui?.requestRender();
		});
		// Bg-shell exit notifier: when a backgrounded shell stops, steer
		// a system-reminder into the agent so the model sees the exit
		// (and can call shell_output for captured logs). If the agent is
		// idle, surface a status note instead — re-waking it just for
		// the notification would be over-eager.
		this.removeBgShellSubscription = this.bundle.backgroundShells.subscribe((shells) => {
			for (const s of shells) {
				const prev = this.bgShellPrevStatus.get(s.id);
				this.bgShellPrevStatus.set(s.id, s.status);
				if (prev !== "running" || s.status === "running") continue;
				const summary =
					s.status === "killed" ? `(killed${s.signal ? ` ${s.signal}` : ""})` : `(exit code ${s.exitCode ?? "?"})`;
				const note = `Background shell ${s.id} ${summary}: ${s.command}`;
				this.statusBar.note(`↪ ${note}`);
				if (this.busy) {
					try {
						this.bundle.agent.steer({
							role: "user",
							content: `<system-reminder>${note}\nCall shell_output("${s.id}") to read the captured output if you need it.</system-reminder>`,
							timestamp: Date.now(),
						});
					} catch {
						// Agent isn't actively running — fine, status note covers it.
					}
				}
			}
			this.tui?.requestRender();
		});

		// Connect MCP servers (async — spawns subprocesses) and splice their
		// tools into the live agent. Surface a status note per server.
		this.bundle
			.connectMcp()
			.then((statuses) => {
				for (const s of statuses) {
					if (s.connected) {
						this.statusBar.note(`⚙ MCP ${s.name}: ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
					} else {
						this.statusBar.note(`⚙ MCP ${s.name}: failed — ${s.error ?? "unknown"}`);
					}
				}
				// Register MCP prompts as /mcp__server__name commands.
				const promptCmds = buildMcpPromptCommands(this.bundle.mcp.prompts(), this.bundle.mcp, this.registry);
				if (promptCmds.length > 0) {
					this.registry.registerAll(promptCmds);
					this.refreshAutocomplete();
					this.statusBar.note(`⚙ MCP: ${promptCmds.length} prompt command${promptCmds.length === 1 ? "" : "s"}`);
				}
				this.tui?.requestRender();
			})
			.catch(() => undefined);

		// Skills load async and register as slash commands — same late-splice
		// pattern as MCP. The autocomplete provider snapshots the command
		// list at construction, so rebuild it once the skills land.
		this.bundle.assets
			.listSkills()
			.then((loaded) => {
				if (loaded.length === 0) return;
				this.registry.registerAll(buildSkillCommands(loaded, this.registry));
				this.refreshAutocomplete();
			})
			.catch(() => undefined);
	}

	/** Rebuild the editor's autocomplete from the current command registry. */
	private refreshAutocomplete(): void {
		const items: AutocompleteItem[] = this.registry.list().map((cmd) => ({
			value: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description,
		}));
		this.inputBar?.setAutocompleteProvider(new CombinedAutocompleteProvider(items, this.bundle.toolContext.cwd));
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

	/**
	 * Fire the SessionEnd hook once, as the CLI is shutting down. Awaited by
	 * the runtime before teardown so blocking cleanup hooks (commit-on-exit,
	 * flush-metrics) get to run; per-hook timeouts bound the wait.
	 */
	async fireSessionEnd(reason: string): Promise<void> {
		await this.bundle.hooks
			.dispatch("SessionEnd", {
				event: "SessionEnd",
				workingDir: this.bundle.toolContext.cwd,
				endReason: reason,
			})
			.catch(() => undefined);
	}

	/**
	 * Ctrl-O copy mode: open a picker over the transcript's copy boxes
	 * (newest first). Selecting one pushes its exact text to the clipboard
	 * via OSC 52 — clean, unwrapped, works over SSH, no mouse capture so
	 * native select + scroll stay intact.
	 */
	private showCopyPickerOverlay(): void {
		if (!this.tui) return;
		const entries = this.copyRegistry.list();
		if (entries.length === 0) {
			this.statusBar.note("Nothing to copy yet — copy boxes appear when the agent emits code or a copy payload.");
			this.tui.requestRender();
			return;
		}
		const component = new CopyPickerOverlay(
			entries,
			(entry) => {
				this.hideCopyPickerOverlay();
				void copyToClipboard(entry.text)
					.then((res) => this.statusBar.note(`⎘ copied ${res.bytes} bytes via ${res.method}`))
					.catch((err) => this.statusBar.note(`copy failed: ${err instanceof Error ? err.message : String(err)}`))
					.finally(() => this.tui?.requestRender());
			},
			() => this.hideCopyPickerOverlay(),
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 50 });
		this.tui.setFocus(component.getFocusTarget());
		this.copyPickerOverlay = { handle, component };
	}

	private hideCopyPickerOverlay(): void {
		if (!this.copyPickerOverlay) return;
		this.copyPickerOverlay.handle.hide();
		this.copyPickerOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
		this.tui?.requestRender();
	}

	/** Pull an image off the clipboard and stage it for the next prompt. */
	private async attachClipboardImage(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				this.statusBar.note("No image on the clipboard (copy one first; needs pngpaste / wl-paste / xclip).");
			} else {
				this.pendingImages.push(image);
				const kb = Math.round((image.data.length * 3) / 4 / 1024);
				this.statusBar.note(`📎 image attached (${kb} KB) — send a message to include it.`);
			}
		} catch {
			this.statusBar.note("Couldn't read the clipboard image.");
		}
		this.tui?.requestRender();
	}

	/** Dynamic terminal title: cwd basename + a ● marker while a turn runs. */
	private setTitle(working: boolean): void {
		const dir = basename(this.bundle.toolContext.cwd) || "codebase";
		setTerminalTitle(working ? `● codebase · ${dir}` : `codebase · ${dir}`);
	}

	/**
	 * Forecast the user's next prompt once the agent settles. 500ms
	 * debounce lets idle stabilize; any new activity cancels the in-flight
	 * call so a stale suggestion can't surface mid-turn. Same generator
	 * and env opt-out as the ink UI.
	 */
	private scheduleSuggestion(): void {
		this.cancelSuggestion();
		if (process.env.CODEBASE_NO_SUGGESTIONS === "1") return;
		if (this.busy || this.messages.length < 2) return;
		const ac = new AbortController();
		this.suggestionAbort = ac;
		this.suggestionTimer = setTimeout(() => {
			void generateSuggestion(this.bundle, { signal: ac.signal })
				.then((text) => {
					if (ac.signal.aborted || !text || this.busy) return;
					this.suggestionLine.set(text);
					this.tui?.requestRender();
				})
				.catch(() => undefined);
		}, 500);
	}

	private cancelSuggestion(): void {
		if (this.suggestionTimer) clearTimeout(this.suggestionTimer);
		this.suggestionTimer = undefined;
		this.suggestionAbort?.abort();
		this.suggestionAbort = undefined;
		if (this.suggestionLine.get()) {
			this.suggestionLine.set(undefined);
			this.tui?.requestRender();
		}
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		// Ctrl-O opens the copy picker when no other modal owns input.
		if (
			data === "\x0f" &&
			this.inputBar &&
			!this.copyPickerOverlay &&
			!this.permissionOverlay &&
			!this.userQueryOverlay &&
			!this.modelPickerOverlay &&
			!this.historySearchOverlay &&
			!this.rewindOverlay &&
			!this.tournamentOverlay
		) {
			this.showCopyPickerOverlay();
			return { consume: true };
		}
		// Ctrl-V attaches an image from the system clipboard to the next
		// prompt (text paste arrives via bracketed paste, not Ctrl-V).
		if (data === "\x16" && this.inputBar) {
			void this.attachClipboardImage();
			return { consume: true };
		}
		// Ctrl-G hands the current input buffer to $EDITOR for composing a
		// long / multi-line prompt, then drops the result back in the editor.
		if (
			data === "\x07" &&
			this.inputBar &&
			!this.copyPickerOverlay &&
			!this.permissionOverlay &&
			!this.userQueryOverlay &&
			!this.modelPickerOverlay &&
			!this.historySearchOverlay &&
			!this.rewindOverlay &&
			!this.tournamentOverlay
		) {
			this.composeInExternalEditor();
			return { consume: true };
		}
		// Ghost suggestion: Tab on an empty editor accepts it; any other
		// keystroke dismisses it (and still reaches the editor).
		const ghost = this.suggestionLine.get();
		if (ghost) {
			if (data === "\t" && this.inputBar && this.inputBar.getText().length === 0) {
				this.cancelSuggestion();
				this.inputBar.setText(ghost);
				this.tui?.requestRender();
				return { consume: true };
			}
			this.cancelSuggestion();
		}
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
			// A running tournament owns the first Ctrl-C: cancel the race
			// (its contestants get the abort signal) instead of exiting.
			if (this.tournamentRunning) {
				this.statusBar.note("cancelling tournament…");
				this.tournamentAbort?.abort();
				return { consume: true };
			}
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
		// Ctrl-D on an empty editor is readline EOF — treat it as the same
		// exit signal as Ctrl-C double-tap. Non-empty editor falls through
		// to Editor's own handling (forward-delete).
		if (data === "\x04" && !this.busy && this.inputBar && this.inputBar.getText().length === 0) {
			this.exitResolve?.();
			return { consume: true };
		}
		// Ctrl-R opens reverse history search when no other modal is up.
		// (Once open, the overlay's own input handles the repeat-Ctrl-R cycle.)
		if (
			data === "\x12" &&
			this.inputBar &&
			!this.historySearchOverlay &&
			!this.permissionOverlay &&
			!this.userQueryOverlay &&
			!this.modelPickerOverlay &&
			!this.rewindOverlay &&
			!this.tournamentOverlay
		) {
			this.showHistorySearchOverlay();
			return { consume: true };
		}
		return undefined;
	}

	/**
	 * Fire-and-forget background memory extraction after a settled turn. The
	 * extractor self-throttles (only runs once enough new turns accrue), so
	 * calling it every agent_end is cheap. Saved memories are announced
	 * quietly so the user knows what was remembered.
	 */
	private scheduleMemoryExtraction(): void {
		void this.bundle.memoryExtractor
			.maybeExtract(this.messages)
			.then((saved) => {
				if (saved.length === 0) return;
				const titles = saved.map((r) => r.name).join(", ");
				this.statusBar.note(
					`📝 remembered ${saved.length === 1 ? "1 thing" : `${saved.length} things`}: ${titles}`,
				);
				this.tui?.requestRender();
			})
			.catch(() => undefined);
	}

	private showRewindOverlay(): void {
		if (!this.tui || !this.inputBar) return;
		if (this.busy) {
			this.statusBar.note("can't rewind mid-turn — press Ctrl-C to stop the agent first.");
			return;
		}
		const points = listRewindPoints(this.messages);
		if (points.length === 0) {
			this.statusBar.note("nothing to rewind to yet — no prior prompts this session.");
			return;
		}
		this.hideRewindOverlay();
		const component = new RewindOverlay(
			points,
			(point) => {
				this.hideRewindOverlay();
				this.performConversationRewind(point);
			},
			() => this.hideRewindOverlay(),
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 50 });
		this.tui.setFocus(component.getFocusTarget());
		this.rewindOverlay = { handle, component };
	}

	private hideRewindOverlay(): void {
		if (!this.rewindOverlay) return;
		this.rewindOverlay.handle.hide();
		this.rewindOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
		this.tui?.requestRender();
	}

	/**
	 * Drop the chosen prompt and everything after it from both the on-screen
	 * transcript and the agent's context, then restore any files edited
	 * since that prompt to their prior state. The conversation resumes as if
	 * the rewound turns never happened.
	 */
	private performConversationRewind(point: RewindPoint): void {
		const truncated = truncateBefore(this.messages, point.index);
		const dropped = this.messages.length - truncated.length;
		this.messages.length = 0;
		this.messages.push(...truncated);
		this.bundle.agent.state.messages = [...truncated];
		this.transcript.clear();
		for (const m of truncated) this.transcript.appendMessage(m);

		// Restore files mutated at or after the rewound prompt.
		let fileNote = "";
		const seq = this.bundle.checkpoints.firstSeqAtOrAfter(point.timestamp);
		if (seq !== undefined) {
			const result = this.bundle.checkpoints.rewindTo(seq);
			for (const f of [...result.restored, ...result.deleted]) {
				this.bundle.toolContext.fileStateCache.invalidate(f.path);
			}
			const restored = result.restored.length + result.deleted.length;
			if (restored > 0) fileNote = ` · restored ${restored} file${restored === 1 ? "" : "s"}`;
			if (result.skipped.length > 0) fileNote += ` (${result.skipped.length} skipped)`;
		}
		this.statusBar.note(`↺ rewound ${dropped} message${dropped === 1 ? "" : "s"}${fileNote}.`);
		this.tui?.requestRender();
	}

	/**
	 * Run a /tournament: snapshot the working tree, race general agents on
	 * `task` in isolated worktrees, then open the results picker so the user
	 * can merge a winner. With `opts.models`, one contestant runs per model
	 * id; otherwise `opts.count` copies of the current model race. Heavy +
	 * long-running, so it's gated against the agent or another tournament.
	 */
	private async startTournament(task: string, opts: { count: number; models?: string[] }): Promise<void> {
		if (!this.tui) return;
		if (this.busy || this.tournamentRunning) {
			this.statusBar.note("can't start a tournament while the agent (or another tournament) is running.");
			return;
		}
		this.tournamentRunning = true;
		this.tournamentAbort = new AbortController();
		const cwd = this.bundle.toolContext.cwd;
		try {
			const snap = await snapshotWorkingTree(cwd, this.tournamentAbort.signal);
			const branches: BranchSpec[] = opts.models
				? opts.models.map((model, i) => ({ id: String.fromCharCode(65 + i), model }))
				: Array.from({ length: opts.count }, (_, i) => ({ id: String.fromCharCode(65 + i) }));
			const status = new Map<string, string>(branches.map((b) => [b.id, "queued"]));
			const renderStatus = () => {
				const parts = branches.map((b) => `${b.id}${b.model ? `(${b.model})` : ""}:${status.get(b.id)}`);
				this.statusBar.note(`🏁 tournament — ${parts.join("  ")}`);
				this.tui?.requestRender();
			};
			renderStatus();

			const runContestant = createContestantRunner(this.bundle.toolContext, defaultContestantPrompt);
			const onProgress = (e: TournamentProgress) => {
				if (e.type === "branch_start") status.set(e.id, "working…");
				else if (e.type === "branch_tool") status.set(e.id, e.tool);
				else if (e.type === "branch_done") status.set(e.id, e.error ? "failed" : `done (${e.filesChanged})`);
				else if (e.type === "judging") this.statusBar.note("🏁 tournament — judging attempts…");
				if (e.type !== "judging") renderStatus();
			};

			const outcome = await runTournament({
				task,
				cwd,
				baseSha: snap.sha,
				branches,
				runContestant,
				judge: this.bundle.glue,
				signal: this.tournamentAbort.signal,
				onProgress,
			});
			// Cancelled mid-race: tear down the worktrees, skip the picker.
			if (this.tournamentAbort.signal.aborted) {
				await cleanupTournament(cwd, outcome.branches);
				this.statusBar.note("tournament cancelled — nothing merged.");
				this.tournamentRunning = false;
				return;
			}
			this.statusBar.note("");
			this.showTournamentOverlay(outcome, snap.sha, task);
		} catch (err) {
			const cancelled = this.tournamentAbort?.signal.aborted;
			this.statusBar.note(
				cancelled
					? "tournament cancelled — nothing merged."
					: `tournament failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.tournamentRunning = false;
		}
	}

	private showTournamentOverlay(outcome: TournamentOutcome, baseSha: string, task: string): void {
		if (!this.tui) {
			this.tournamentRunning = false;
			return;
		}
		const component = new TournamentOverlay(
			outcome,
			(branchId) => {
				this.hideTournamentOverlay();
				void this.applyTournamentPick(outcome, baseSha, task, branchId);
			},
			() => {
				this.hideTournamentOverlay();
				void this.discardTournament(outcome);
			},
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "80%", minWidth: 60 });
		this.tui.setFocus(component.getFocusTarget());
		this.tournamentOverlay = { handle, component };
	}

	private hideTournamentOverlay(): void {
		if (!this.tournamentOverlay) return;
		this.tournamentOverlay.handle.hide();
		this.tournamentOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
		this.tui?.requestRender();
	}

	private async applyTournamentPick(
		outcome: TournamentOutcome,
		baseSha: string,
		task: string,
		branchId: string,
	): Promise<void> {
		const cwd = this.bundle.toolContext.cwd;
		const winner = outcome.branches.find((b) => b.id === branchId);
		try {
			if (!winner || winner.error || winner.filesChanged.length === 0) {
				this.statusBar.note(`attempt ${branchId} has nothing to merge.`);
				return;
			}
			const result = await mergeWinner(cwd, baseSha, winner);
			if (!result.applied) {
				this.statusBar.note(
					`couldn't auto-merge attempt ${branchId}: ${result.error}. Its worktree is kept at ${winner.worktree?.path}.`,
				);
				// Don't discard the winner's worktree — user may merge by hand.
				const losers = outcome.branches.filter((b) => b.id !== branchId);
				await cleanupTournament(cwd, losers);
				return;
			}
			for (const rel of winner.filesChanged) {
				this.bundle.toolContext.fileStateCache.invalidate(isAbsolute(rel) ? rel : resolvePath(cwd, rel));
			}
			// Tell the agent what landed so the conversation reflects the new files.
			this.injectTournamentNote(task, winner.id, winner.filesChanged);
			this.statusBar.note(
				`✓ merged attempt ${branchId} — ${winner.filesChanged.length} file${winner.filesChanged.length === 1 ? "" : "s"} changed.`,
			);
			await cleanupTournament(cwd, outcome.branches);
		} finally {
			this.tournamentRunning = false;
			this.tui?.requestRender();
		}
	}

	private async discardTournament(outcome: TournamentOutcome): Promise<void> {
		try {
			await cleanupTournament(this.bundle.toolContext.cwd, outcome.branches);
			this.statusBar.note("tournament discarded — nothing merged.");
		} finally {
			this.tournamentRunning = false;
			this.tui?.requestRender();
		}
	}

	/** Append a hidden context note so the next turn knows what the tournament merged. */
	private injectTournamentNote(task: string, branchId: string, files: string[]): void {
		const note =
			`<system-reminder>A /tournament just merged attempt ${branchId} for the task "${task}". ` +
			`Files changed: ${files.join(", ")}. These edits are now in the working tree.</system-reminder>`;
		const msg = { role: "user" as const, content: note, timestamp: Date.now() } as AgentMessage;
		this.messages.push(msg);
		this.bundle.agent.state.messages = [...this.bundle.agent.state.messages, msg];
	}

	private composeInExternalEditor(): void {
		if (!this.inputBar) return;
		const edited = editInExternalEditor(this.inputBar.getText(), {
			suspend: () => this.tui?.stop(),
			resume: () => {
				this.tui?.start();
				this.tui?.requestRender(true);
			},
		});
		if (edited !== null) this.inputBar.setText(edited);
		this.tui?.requestRender(true);
	}

	private showHistorySearchOverlay(): void {
		if (!this.tui || !this.inputBar) return;
		// Persisted prior runs ++ this session's prompts, chronological.
		const history = [...this.historyStore.load()];
		for (const m of this.messages) {
			if (m.role !== "user" || typeof m.content !== "string") continue;
			if (m.content.trim() && history[history.length - 1] !== m.content) history.push(m.content);
		}
		const component = new HistorySearchOverlay(
			history,
			(text) => {
				this.hideHistorySearchOverlay();
				this.inputBar?.setText(text);
				this.tui?.requestRender();
			},
			() => this.hideHistorySearchOverlay(),
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 50 });
		this.tui.setFocus(component.getFocusTarget());
		this.historySearchOverlay = { handle, component };
	}

	private hideHistorySearchOverlay(): void {
		if (!this.historySearchOverlay) return;
		this.historySearchOverlay.handle.hide();
		this.historySearchOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
		this.tui?.requestRender();
	}

	private async handleSubmit(text: string): Promise<void> {
		// Both call sites fire this as a floating promise (`void`). Any
		// throw in the early branches — slash dispatch, @path attachment
		// resolution, !shell escape — would otherwise reject silently and
		// the prompt would vanish with no error. Wrap the whole body so a
		// failure always surfaces as an error card instead of dead air.
		try {
			await this.handleSubmitInner(text);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.errorCard.show(msg);
			this.busy = false;
			this.status = "idle";
			this.statusBar.setStatus("idle");
			this.stopRateSampling();
			this.stopSpinners();
			this.tui?.requestRender();
		}
	}

	private async handleSubmitInner(text: string): Promise<void> {
		const trimmed = text.trim();
		// Allow an image-only submit (Ctrl-V then Enter with no text).
		if (!trimmed && this.pendingImages.length === 0) return;

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
		// `# note` quick-adds a memory without spending an agent turn.
		if (trimmed.startsWith("#") && trimmed.length > 1) {
			try {
				const rec = quickAddMemory(this.bundle.memory, trimmed);
				this.statusBar.note(`📌 saved ${rec.type} memory: ${rec.name}`);
			} catch (err) {
				this.statusBar.note(`couldn't save memory: ${err instanceof Error ? err.message : String(err)}`);
			}
			this.persistHistory(trimmed);
			this.tui?.requestRender();
			return;
		}

		// Mid-turn typing: agent is busy → STEER the live turn. The message
		// is injected into the running agent loop via the steering queue,
		// so the model sees the correction/addition before its next tool
		// batch rather than only after the whole turn finishes. This is the
		// Claude-Code "type while it works" behavior. The message also lands
		// in the transcript so the user sees what they steered with.
		if (this.busy) {
			if (!trimmed) {
				this.statusBar.note("Finish the current turn before sending an image.");
				return;
			}
			const userMsg: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
			this.messages.push(userMsg);
			this.transcript.appendUserMessage(trimmed);
			this.persistHistory(trimmed);
			try {
				this.bundle.agent.steer(userMsg);
				const preview = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
				this.statusBar.note(`↳ steering: ${preview}`);
			} catch {
				// steer() throws only if there's no active run — race between
				// the busy check and the turn settling. Fall back to the queue
				// so the message isn't lost.
				this.queuedPrompts.push(trimmed);
			}
			this.tui?.requestRender();
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

		const imageCount = this.pendingImages.length;
		const display = trimmed || (imageCount > 0 ? `📎 ${imageCount} image${imageCount === 1 ? "" : "s"}` : "");
		const userMsg: AgentMessage = { role: "user", content: display, timestamp: Date.now() };
		this.messages.push(userMsg);
		this.transcript.appendUserMessage(display);
		if (trimmed) this.persistHistory(trimmed);

		// Glue-router classification: plan-style requests run through the
		// plan flow (Q&A → reviewable plan → agent); everything else
		// falls through to the regular agent.prompt path. The chat
		// intercept was removed — small talk and meta-questions now go
		// to the main agent like any other turn. Router failures degrade
		// to the agent so a flaky cheap model never silently eats real work.
		const hadHistory = this.messages.length > 1;
		try {
			const route = await routeUserInput(this.bundle.glue, trimmed, { hasHistory: hadHistory });
			if (route.kind === "plan") {
				this.busy = true;
				this.status = "thinking";
				this.statusBar.setStatus("planning");
				await runPlanFlow(this.bundle, trimmed, {
					onReply: (reply) => this.appendSyntheticAssistant(reply),
					onError: (message) => this.statusBar.note(`plan error: ${message}`),
					envReminderForFirstTurn: this.envInjected
						? undefined
						: buildEnvironmentReminder(this.bundle.toolContext.cwd),
				});
				this.envInjected = true;
				this.busy = false;
				this.status = "idle";
				this.statusBar.setStatus("idle");
				this.maybeDrainQueue();
				return;
			}
		} catch (err) {
			this.statusBar.note(`(router fell back to agent: ${err instanceof Error ? err.message : String(err)})`);
		}

		let promptText = augmented;
		if (!this.envInjected) {
			promptText = `${buildEnvironmentReminder(this.bundle.toolContext.cwd)}\n\n${augmented}`;
			this.envInjected = true;
		}
		// Route through the bundle helper so UserPromptSubmit hooks fire
		// and can veto the submit. A blocked prompt surfaces the hook's
		// stderr as a status-bar note. A real error (agent throws before
		// reaching agent_start) surfaces as an ErrorCard — otherwise the
		// user just sees their prompt land with no response.
		// Attach + clear any clipboard images staged with Ctrl-V.
		const images = this.pendingImages.length > 0 ? this.pendingImages : undefined;
		this.pendingImages = [];
		this.bundle
			.submitUserPrompt(promptText, images)
			.then((result) => {
				if (!result.submitted && result.reason) {
					this.statusBar.note(`Prompt blocked by hook: ${result.reason}`);
					return;
				}
				if (result.error) {
					this.errorCard.show(result.error);
					this.busy = false;
					this.status = "idle";
					this.statusBar.setStatus("idle");
					this.stopRateSampling();
					this.stopSpinners();
					this.tui?.requestRender();
				}
			})
			.catch((e) => {
				// submitUserPrompt shouldn't reject anymore, but if it does
				// (hook subsystem throwing, etc.) we still want the user to
				// see something instead of a frozen prompt.
				const msg = e instanceof Error ? e.message : String(e);
				this.errorCard.show(msg);
				this.busy = false;
				this.status = "idle";
				this.statusBar.setStatus("idle");
				this.stopRateSampling();
				this.stopSpinners();
				this.tui?.requestRender();
			});
	}

	/**
	 * Insert a synthetic assistant message into the transcript without
	 * running an agent turn. Used by the chat short-circuit and by
	 * runPlanFlow when it renders the plan / cancel notices.
	 */
	private appendSyntheticAssistant(text: string): void {
		const msg: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} as AgentMessage;
		this.messages.push(msg);
		this.transcript.appendMessage(msg);
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
			switchModel: (spec) => this.switchModel(spec),
			openModelPicker: () => {
				void this.openModelPicker();
			},
			switchSession: (sessionId) => this.switchSession(sessionId),
			openRewindPicker: () => this.showRewindOverlay(),
			runTournament: (task, opts) => {
				void this.startTournament(task, opts);
			},
		});
		if (!result.handled) {
			this.statusBar.note(`unknown command: ${text.split(/\s/)[0]}`);
		}
	}

	/**
	 * Show the inline model picker overlay. Fetches the available-models
	 * list lazily on open (proxy sessions only); BYOK setups can't switch
	 * mid-session — they pick at launch via env vars.
	 */
	private async openModelPicker(): Promise<void> {
		if (!this.tui) return;
		this.statusBar.note("loading available models…");
		try {
			const models = await loadAvailableModels(this.bundle);
			this.statusBar.note("");
			this.showModelPicker(models);
		} catch (err) {
			this.statusBar.note(`model list failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private showModelPicker(models: ModelOption[]): void {
		if (!this.tui) return;
		this.hideModelPicker();
		const component = new ModelPickerOverlay(
			this.bundle.model.id,
			this.bundle.model.provider,
			models,
			(spec) => {
				this.hideModelPicker();
				void this.switchModel(spec);
			},
			() => this.hideModelPicker(),
		);
		const handle = this.tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 50 });
		this.tui.setFocus(component.getFocusTarget());
		this.modelPickerOverlay = { handle, component };
	}

	private hideModelPicker(): void {
		if (!this.modelPickerOverlay) return;
		this.modelPickerOverlay.handle.hide();
		this.modelPickerOverlay = undefined;
		if (this.inputBar) this.tui?.setFocus(this.inputBar);
	}

	/**
	 * Mid-session model swap. Aborts the current turn if active, persists
	 * the choice, then rebuilds the agent bundle with the new model
	 * keeping the existing transcript so the conversation continues
	 * seamlessly. `spec === null` clears the preference and reverts to
	 * the proxy's Codebase Auto default.
	 */
	private async switchModel(spec: { provider?: string; modelId: string } | null): Promise<void> {
		try {
			if (this.bundle.agent.signal && !this.bundle.agent.signal.aborted) {
				try {
					this.bundle.agent.abort();
				} catch {
					// Already done; not a problem.
				}
			}
			try {
				new ConfigStore({ cwd: this.bundle.toolContext.cwd }).setPreferredModel(spec ?? null);
			} catch {
				// Persistence is non-fatal — the in-session swap will still work.
			}
			const previousMessages = [...this.messages];
			this.unsubscribe();
			// Tear down the old bundle's MCP subprocesses + checkpoint blobs
			// before building the new one — a /model switch must not leak.
			this.bundle.mcp.dispose();
			this.bundle.checkpoints.dispose();
			const next = createAgent({
				cwd: this.bundle.toolContext.cwd,
				modelOverride: spec ?? undefined,
				initialMessages: previousMessages,
				resume: false,
			});
			this.adoptBundle(next);
			this.statusBar.note(`Switched to ${next.model.name} (${next.model.provider}/${next.model.id}).`);
		} catch (err) {
			this.statusBar.note(`model switch failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async switchSession(sessionId: string): Promise<void> {
		try {
			if (this.bundle.agent.signal && !this.bundle.agent.signal.aborted) {
				try {
					this.bundle.agent.abort();
				} catch {
					// Already done; not a problem.
				}
			}
			this.unsubscribe();
			this.bundle.mcp.dispose();
			this.bundle.checkpoints.dispose();
			const next = createAgent({ cwd: this.bundle.toolContext.cwd, resume: true, sessionId });
			this.adoptBundle(next);
			// Replace the on-screen transcript with the resumed session's.
			this.transcript.clear();
			this.messages.length = 0;
			this.messages.push(...next.resumedMessages);
			for (const m of next.resumedMessages) this.transcript.appendMessage(m);
			const when = next.resumedFrom ? new Date(next.resumedFrom.updatedAt).toLocaleString() : "unknown time";
			this.statusBar.note(`Resumed session from ${when} (${next.resumedMessages.length} messages).`);
			this.tui?.requestRender();
		} catch (err) {
			this.statusBar.note(`session switch failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Swap in a freshly-built bundle: reconnect MCP, re-subscribe agent
	 * events, and re-bind every bundle-scoped store/panel. Shared by
	 * /model and /resume swaps.
	 */
	private adoptBundle(next: AgentBundle): void {
		this.bundle = next;
		// Re-connect MCP on the fresh bundle so its tools are available
		// again. Fire-and-forget; status notes surface as servers come up.
		next
			.connectMcp()
			.then(() => this.tui?.requestRender())
			.catch(() => undefined);
		// Same async handler pattern as the constructor — needed so the
		// event loop can yield between events, otherwise a burst of
		// agent events drains the microtask queue and renders/spinners
		// stall until the user presses a key.
		this.unsubscribe = this.bundle.subscribe(async (event) => {
			debugLog(`event=${event.type} tui=${!!this.tui} busy=${this.busy} spinnerTimer=${!!this.spinnerTimer}`);
			this.handleAgentEvent(event);
		});
		this.statusBar.setModelName(next.model.name);
		// Re-bind every bundle-scoped store: compaction monitor, tasks,
		// and background shells all changed reference when createAgent
		// produced a fresh bundle.
		this.compactionBanner.rebind(next.compactionMonitor);
		this.taskPanel.rebind(next.toolContext.tasks);
		this.bgShellPanel.rebind(next.backgroundShells);
		// Permissions + userQuery stores are also bundle-scoped, re-subscribe.
		this.removePermSubscription?.();
		this.removeUserQuerySubscription?.();
		this.removePermSubscription = this.bundle.permissions.subscribe((req) => {
			if (req) this.showPermissionOverlay(req);
			else this.hidePermissionOverlay();
			this.tui?.requestRender();
		});
		this.removeUserQuerySubscription = this.bundle.userQueries.subscribe((q) => {
			if (q) this.showUserQueryOverlay(q);
			else this.hideUserQueryOverlay();
			this.tui?.requestRender();
		});
		// Re-bind the bg-shell exit notifier against the new bundle.
		// Reset the prev-status tracker so a fresh bundle gets clean
		// transitions instead of carrying state from the prior agent.
		this.removeBgShellSubscription?.();
		this.bgShellPrevStatus = new Map();
		this.removeBgShellSubscription = this.bundle.backgroundShells.subscribe((shells) => {
			for (const s of shells) {
				const prev = this.bgShellPrevStatus.get(s.id);
				this.bgShellPrevStatus.set(s.id, s.status);
				if (prev !== "running" || s.status === "running") continue;
				const summary =
					s.status === "killed" ? `(killed${s.signal ? ` ${s.signal}` : ""})` : `(exit code ${s.exitCode ?? "?"})`;
				this.statusBar.note(`↪ Background shell ${s.id} ${summary}: ${s.command}`);
			}
			this.tui?.requestRender();
		});
	}

	private buildChatStateShadow(): ChatState {
		return {
			messages: [...this.messages],
			tools: new Map(this.tools),
			status: this.status,
			usage: this.usage,
			turnUsage: this.turnUsage,
			streaming: this.streamingMessage,
			model: {
				provider: this.bundle.model.provider,
				id: this.bundle.model.id,
				name: this.bundle.model.name,
			},
		};
	}

	/**
	 * Recompute the right-hand status-bar metrics — ctx-fill %, total cost,
	 * and (when streaming) live tok/s. Cheap to call on every agent event;
	 * pi-tui only redraws if the text actually changes.
	 */
	private pushMetrics(): void {
		const state = this.buildChatStateShadow();
		const usedTokens = estimateContextTokens(state);
		// Use the resolved model's real context window — a hardcoded 200k was
		// wrong for local 8k models and 1M-context routes alike. Mirror the
		// compaction engine, which already trusts model.contextWindow.
		const contextWindow = this.bundle.model.contextWindow || 200_000;
		const ctxPct = contextWindow > 0 ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;
		this.statusBar.setMetrics(ctxPct, this.usage.cost.total, this.computeTokRate());
		this.contextWarning.setPercent(ctxPct);
	}

	private computeTokRate(): number | undefined {
		if (this.status !== "streaming" || this.rateSamples.length < 2) return undefined;
		const oldest = this.rateSamples[0];
		const newest = this.rateSamples[this.rateSamples.length - 1];
		const dt = (newest.t - oldest.t) / 1000;
		if (dt < 0.5) return undefined;
		const dc = newest.c - oldest.c;
		if (dc < 10) return undefined;
		return Math.round(dc / CHARS_PER_TOKEN / dt);
	}

	private startRateSampling(): void {
		this.stopRateSampling();
		this.rateSamples = [];
		this.rateTimer = setInterval(() => {
			const now = Date.now();
			const state = this.buildChatStateShadow();
			this.rateSamples.push({ t: now, c: streamingChars(state) });
			const cutoff = now - 4000;
			while (this.rateSamples.length > 0 && this.rateSamples[0].t < cutoff) {
				this.rateSamples.shift();
			}
			this.pushMetrics();
			this.tui?.requestRender();
		}, 500);
	}

	private stopRateSampling(): void {
		if (this.rateTimer) {
			clearInterval(this.rateTimer);
			this.rateTimer = undefined;
		}
		this.rateSamples = [];
	}

	/** Start the spinner timer when the agent goes busy. Idempotent. */
	private startSpinners(): void {
		if (this.spinnerTimer) {
			debugLog("startSpinners called but timer already running");
			return;
		}
		debugLog("startSpinners installing timer");
		this.spinnerTimer = setInterval(() => {
			debugLog("spinner tick");
			this.statusBar.tickThrobber();
			this.transcript.tickSpinners();
			this.tui?.requestRender();
		}, 90);
	}

	private stopSpinners(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	private maybeDrainQueue(): void {
		if (this.busy || this.queuedPrompts.length === 0) return;
		const next = this.queuedPrompts.shift();
		if (next) void this.handleSubmit(next);
	}

	private handleAgentEvent(event: AgentEvent): void {
		debugLog(`event=${event.type}`);
		switch (event.type) {
			case "agent_start":
				this.cancelSuggestion();
				this.busy = true;
				this.turnStartedAt = Date.now();
				this.setTitle(true);
				this.status = "thinking";
				this.statusBar.setStatus("thinking");
				this.startSpinners();
				// Track whether any assistant content actually lands during
				// this turn. If agent_end fires with zero messages and no
				// errorMessage, we surface that as a status note — otherwise
				// the user sees their prompt land, status flip to idle, and
				// nothing else.
				this.assistantMessagesThisTurn = 0;
				// Any new turn clears any stale error from the prior run.
				this.errorCard.hide();
				// Immediate paint on turn start so the user sees "thinking"
				// + throbber without waiting on the 16ms render timer.
				this.tui?.requestRender();
				break;
			case "turn_start":
				this.status = "thinking";
				this.statusBar.setStatus("thinking");
				this.errorCard.hide();
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.status = "streaming";
					this.transcript.setStreaming(event.message);
					this.statusBar.setStatus("writing");
					this.startRateSampling();
				}
				break;
			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.transcript.setStreaming(event.message);
					// Streaming tokens are the user-visible signal that the
					// agent is alive — render aggressively per chunk so the
					// text actually appears as it arrives.
					this.tui?.requestRender();
				}
				break;
			case "message_end":
				if (event.message.role !== "user") {
					this.messages.push(event.message);
					this.transcript.appendMessage(event.message);
					this.streamingMessage = undefined;
					this.transcript.setStreaming(undefined);
					this.stopRateSampling();
					if ("usage" in event.message && event.message.usage) {
						this.usage = mergeUsage(this.usage, event.message.usage);
						this.turnUsage = event.message.usage;
					}
					if (event.message.role === "assistant") {
						this.assistantMessagesThisTurn += 1;
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
				this.scheduleSuggestion();
				this.status = "idle";
				this.statusBar.setStatus("idle");
				this.stopRateSampling();
				this.stopSpinners();
				this.setTitle(false);
				// Ring the bell / OS-notify if this turn ran long enough that
				// the user may have looked away. Quick turns stay silent.
				notifyTurnComplete({
					elapsedMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
					summary: lastAssistantText(this.messages),
				});
				// errorMessage lives on the agent state, not the event payload.
				// Surface an error card when the turn finished badly; the next
				// successful turn hides it again.
				{
					const errMsg = this.bundle.agent.state.errorMessage;
					if (errMsg) {
						this.errorCard.show(errMsg);
					} else {
						this.errorCard.hide();
						// agent_end without errorMessage AND without any assistant
						// message means the turn produced no visible output —
						// usually a model that returned empty, a misconfigured
						// proxy route, or a tool turn that settled before content
						// streamed. Surface it so the user knows the silence is
						// from the model side, not a UI hang.
						if (this.assistantMessagesThisTurn === 0) {
							debugLog("agent_end with 0 assistant messages this turn");
							this.statusBar.note("(no response from the model — try again, or /model to switch)");
						}
					}
				}
				this.maybeDrainQueue();
				this.scheduleMemoryExtraction();
				break;
		}
		this.pushMetrics();
		// Pi-tui only paints on input events or explicit requestRender calls.
		// Agent events come from pi-agent-core's stream — without this kick
		// the UI sits idle until the user presses a key. Match what
		// pi-mono's reference coding-agent does after every event.
		this.tui?.requestRender();
	}

	dispose(): void {
		this.cancelSuggestion();
		this.hideCopyPickerOverlay();
		this.removeInputListener?.();
		this.removePermSubscription?.();
		this.removeUserQuerySubscription?.();
		this.removeBgShellSubscription?.();
		this.hidePermissionOverlay();
		this.hideUserQueryOverlay();
		this.hideModelPicker();
		this.hideRewindOverlay();
		this.hideTournamentOverlay();
		this.tournamentAbort?.abort();
		this.stopRateSampling();
		this.stopSpinners();
		this.statusBar.dispose();
		this.compactionBanner.dispose();
		this.taskPanel.dispose();
		this.bgShellPanel.dispose();
		this.bundle.backgroundShells.killAllSync();
		this.bundle.mcp.dispose();
		this.bundle.checkpoints.dispose();
		this.unsubscribe();
	}
}

/**
 * Fetch the /models endpoint from the proxy session. Mirrors the ink
 * path's helper — kept inline here so the pi-tui code doesn't reach
 * back into `src/ui/App.tsx`, which goes away in phase 5.
 */
async function loadAvailableModels(bundle: AgentBundle): Promise<ModelOption[]> {
	if (bundle.source !== "proxy") {
		throw new Error("BYOK session — use CODEBASE_PROVIDER + CODEBASE_MODEL env vars at launch to switch.");
	}
	const baseUrl = (bundle.model.baseUrl ?? "").replace(/\/+$/, "");
	if (!baseUrl) throw new Error("model has no baseUrl — can't query the proxy");
	const apiKey = await bundle.agent.getApiKey?.(bundle.model.provider);
	if (!apiKey) throw new Error("not signed in — run `codebase auth login`");
	const res = await fetch(`${baseUrl}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	const json = (await res.json()) as { models?: ModelOption[] };
	return json.models ?? [];
}

/**
 * Bottom-of-screen status bar. Throbber + state label on the left, cwd
 * basename + ctx-bar + tok/s + cost on the right. Mirrors ink-era
 * Status.tsx — busy state shows an animated pulse-block character; idle
 * is silent.
 */
const THROBBER_FRAMES = ["░", "▒", "▓", "█", "█", "▓", "▒", "░"];

/** Max status notes to keep in the rolling buffer. Beyond this oldest entries roll off. */
const STATUS_NOTE_BUFFER = 8;

class StatusBar extends Container {
	private readonly line: Text;
	private readonly notesContainer: Container;
	private noteBuffer: string[] = [];
	private modelName: string;
	private readonly cwdLabel: string;
	private currentStatus = "idle";
	private ctxPercent = 0;
	private cost = 0;
	private tokRate: number | undefined;
	private throbberTick = 0;
	/** Active cycling verb shown while currentStatus is "thinking". */
	private verb = THINKING_VERBS[0];
	private verbTimer: NodeJS.Timeout | undefined;
	private readonly onTick: () => void;
	/** Per-turn cost is only meaningful on metered (BYOK) sessions — the
	 * proxy bills a flat subscription and returns no usage, so $0.0000 there
	 * is noise, not information. Hidden for proxy. */
	private readonly showCost: boolean;
	constructor(modelName: string, cwd: string, onTick: () => void = () => undefined, showCost = true) {
		super();
		this.modelName = modelName;
		this.cwdLabel = basename(cwd) || cwd;
		this.onTick = onTick;
		this.showCost = showCost;
		this.line = new Text(this.format(), 1, 0);
		this.notesContainer = new Container();
		this.addChild(this.notesContainer);
		this.addChild(this.line);
	}
	setStatus(status: string): void {
		this.currentStatus = status;
		if (status === "thinking") {
			this.startVerbCycle();
		} else {
			this.stopVerbCycle();
		}
		this.line.setText(this.format());
		this.line.invalidate();
	}
	private startVerbCycle(): void {
		if (this.verbTimer) return;
		// Reset to "Thinking" so consecutive turns start the cycle fresh
		// rather than picking up wherever the previous turn left off.
		this.verb = THINKING_VERBS[0];
		this.verbTimer = setInterval(() => {
			this.verb = pickNextVerb(this.verb);
			this.line.setText(this.format());
			this.line.invalidate();
			this.onTick();
		}, 3000);
	}
	private stopVerbCycle(): void {
		if (this.verbTimer) {
			clearInterval(this.verbTimer);
			this.verbTimer = undefined;
		}
	}
	dispose(): void {
		this.stopVerbCycle();
	}
	setModelName(name: string): void {
		this.modelName = name;
		this.line.setText(this.format());
		this.line.invalidate();
	}
	setMetrics(ctxPercent: number, cost: number, tokRate?: number): void {
		this.ctxPercent = ctxPercent;
		this.cost = cost;
		this.tokRate = tokRate;
		this.line.setText(this.format());
		this.line.invalidate();
	}
	/** Advance the throbber to the next frame. Called by App on the spinner timer while busy. */
	tickThrobber(): void {
		this.throbberTick = (this.throbberTick + 1) % THROBBER_FRAMES.length;
		this.line.setText(this.format());
		this.line.invalidate();
	}
	/**
	 * Append a status note to the rolling buffer. Empty strings clear the
	 * buffer entirely (useful for ack messages after a loading note).
	 * Beyond STATUS_NOTE_BUFFER lines the oldest entries roll off so the
	 * pane stays bounded.
	 */
	note(line: string): void {
		if (line === "") {
			this.noteBuffer = [];
		} else {
			this.noteBuffer.push(line);
			if (this.noteBuffer.length > STATUS_NOTE_BUFFER) {
				this.noteBuffer = this.noteBuffer.slice(-STATUS_NOTE_BUFFER);
			}
		}
		this.notesContainer.clear();
		for (const entry of this.noteBuffer) {
			this.notesContainer.addChild(new Text(ansi.dim(entry), 1, 0));
		}
		this.notesContainer.invalidate();
	}
	private format(): string {
		const isBusy = this.currentStatus !== "idle";
		const throb = isBusy ? `${ansi.cyan(THROBBER_FRAMES[this.throbberTick])} ` : "";
		const label = this.currentStatus === "thinking" ? this.verb : this.currentStatus;
		const statusLabel = isBusy ? ansi.cyan(label) : ansi.dim(label);
		const bar = ctxBar(this.ctxPercent);
		const ctxText = colorByThreshold(`${bar} ${this.ctxPercent}%`, this.ctxPercent);
		const tokPart = this.tokRate !== undefined ? ` · ${this.tokRate} tok/s` : "";
		const costPart = this.showCost ? ` · $${formatCost(this.cost)}` : "";
		// Model name reads at default brightness as the anchor; the rest of
		// the meta recedes to dim so the line is glanceable, not a wall.
		const meta = ansi.dim(`${this.cwdLabel} · ctx ${ctxText}${tokPart}${costPart}`);
		return `${throb}${statusLabel}    ${this.modelName}  ${meta}`;
	}
}

/** 6-cell eighth-block meter used for the ctx % bar. Mirrors the ink-era version exactly. */
function ctxBar(pct: number): string {
	const cells = 6;
	const totalEighths = Math.round((pct / 100) * cells * 8);
	const full = Math.floor(totalEighths / 8);
	const remainder = totalEighths - full * 8;
	const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
	let out = "█".repeat(Math.min(full, cells));
	if (full < cells && remainder > 0) out += partials[remainder] ?? "";
	while (out.length < cells) out += "░";
	return out;
}

function colorByThreshold(text: string, pct: number): string {
	if (pct >= 90) return ansi.red(text);
	if (pct >= 75) return ansi.yellow(text);
	return text;
}

function formatCost(value: number): string {
	if (value === 0) return "0.0000";
	if (value < 0.01) return value.toFixed(4);
	return value.toFixed(2);
}

/**
 * Append-only transcript display + an optional in-flight streaming pane.
 * Each finalized message becomes a MessageView (renders once via pi-tui's
 * line-diff). The streaming message gets its own MessageView that's
 * rebuilt per agent event so tool-call blocks stay in sync with the
 * shared tools Map.
 */
class TranscriptView extends Container {
	private readonly history: Container;
	private streamingView: MessageView | undefined;
	private streamingMessage: AgentMessage | undefined;
	private readonly tools: ReadonlyMap<string, ToolExecution>;
	private readonly registry: CopyRegistry;
	/** Monotonic, so each finalized message gets a stable CopyBox key namespace. */
	private msgCounter = 0;

	constructor(initialMessages: AgentMessage[], tools: ReadonlyMap<string, ToolExecution>, registry: CopyRegistry) {
		super();
		this.tools = tools;
		this.registry = registry;
		this.history = new Container();
		this.addChild(this.history);
		for (const m of initialMessages) {
			this.history.addChild(buildMessageView(m, this.tools, false, this.copyOpts()));
		}
	}

	private copyOpts(): CopyBoxOptions {
		return { registry: this.registry, keyPrefix: `msg-${this.msgCounter++}` };
	}

	appendUserMessage(text: string): void {
		const msg = { role: "user" as const, content: text, timestamp: Date.now() } as AgentMessage;
		this.history.addChild(buildMessageView(msg, this.tools, false, this.copyOpts()));
		this.history.invalidate();
	}

	appendMessage(message: AgentMessage): void {
		this.history.addChild(buildMessageView(message, this.tools, false, this.copyOpts()));
		this.history.invalidate();
	}

	clear(): void {
		this.history.clear();
		this.history.invalidate();
	}

	setStreaming(message: AgentMessage | undefined): void {
		if (message && this.streamingView && this.streamingMessage?.role === message.role) {
			// Same streaming turn — rebuild content blocks in place so the
			// pi-tui diff renderer only touches changed lines.
			this.streamingMessage = message;
			this.streamingView.setBlocks(buildMessageBlocks(message, this.tools, message.role, { streaming: true }));
			this.streamingView.invalidate();
			this.invalidate();
			return;
		}
		if (this.streamingView) {
			this.removeStreaming();
		}
		if (!message) return;
		this.streamingMessage = message;
		this.streamingView = buildMessageView(message, this.tools, true, { streaming: true });
		this.addChild(this.streamingView);
		this.invalidate();
	}

	/** Called by App on the spinner timer so running tool-call lines re-animate. */
	tickSpinners(): void {
		if (this.streamingView) {
			this.streamingView.invalidate();
			this.invalidate();
		}
	}

	private removeStreaming(): void {
		if (!this.streamingView) return;
		this.removeChild(this.streamingView);
		this.streamingView = undefined;
		this.streamingMessage = undefined;
		this.invalidate();
	}
}

function buildMessageView(
	message: AgentMessage,
	tools: ReadonlyMap<string, ToolExecution>,
	streaming: boolean,
	copy: CopyBoxOptions = {},
): MessageView {
	const role = (message.role as string) ?? "system";
	const kind: MessageKind =
		role === "user" ? "user" : role === "toolResult" ? "tool" : role === "assistant" ? "assistant" : "system";
	const blocks = buildMessageBlocks(message, tools, role, copy);
	return new MessageView({ kind, streaming, blocks });
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
/** First line of the most recent assistant text, for the completion notification. */
function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text =
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content
							.filter(
								(b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
							)
							.map((b) => b.text)
							.join(" ")
					: "";
		const firstLine = text.split("\n").find((l) => l.trim().length > 0);
		if (firstLine) return firstLine;
	}
	return undefined;
}

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

/**
 * Append a line to `~/.codebase/pi-tui-debug.log` when CODEBASE_PI_TUI_DEBUG=1.
 * No-op otherwise. Used to verify event delivery / render timing when the UI
 * looks like it's stuck.
 */
function debugLog(msg: string): void {
	if (process.env.CODEBASE_PI_TUI_DEBUG !== "1") return;
	try {
		appendFileSync(
			`${process.env.HOME ?? "/tmp"}/.codebase/pi-tui-debug.log`,
			`[${new Date().toISOString()}] ${msg}\n`,
		);
	} catch {
		// Filesystem issues shouldn't crash the agent — best effort.
	}
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
