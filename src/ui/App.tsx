import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import { initialState, reducer } from "../agent/events.js";
import { routeUserInput } from "../agent/router.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { CommandRegistry } from "../commands/registry.js";
import type { PermissionRequest } from "../permissions/store.js";
import { runPlanFlow } from "../plan/run-flow.js";
import type { Task } from "../tools/task-store.js";
import type { ChatState } from "../types.js";
import type { UserQuery } from "../user-queries/store.js";
import { buildAttachmentPrompt, collectAttachments } from "./attachments.js";
import { CompactionBanner } from "./CompactionBanner.js";
import { FirstRunSetup } from "./FirstRunSetup.js";
import { HistoryStore } from "./history-store.js";
import { Input, type InputHandle } from "./Input.js";
import { MessageList } from "./MessageList.js";
import { Permission } from "./Permission.js";
import { Status } from "./Status.js";
import { runShellEscape } from "./shell-escape.js";
import { TaskPanel } from "./TaskPanel.js";
import { ToolPanel } from "./ToolPanel.js";
import { UserQueryView } from "./UserQuery.js";
import { useCoalescedAgentEvents } from "./use-coalesced-agent-events.js";
import { usePromptSuggestion } from "./use-prompt-suggestion.js";
import { Welcome } from "./Welcome.js";

export function App() {
	const { exit } = useApp();
	const [setupAttempt, setSetupAttempt] = useState(0);

	// setupAttempt re-runs this memo after the wizard persists creds.
	const { bundle, configError } = useMemo(() => {
		void setupAttempt;
		try {
			// Auto-resume the prior session for this cwd by default. The
			// `--new` CLI flag (parsed in cli.tsx) sets CODEBASE_FRESH so
			// users who explicitly want a clean slate can opt out without
			// having to wipe ~/.codebase/sessions manually.
			const resume = process.env.CODEBASE_FRESH !== "1";
			return { bundle: createAgent({ resume }), configError: undefined as string | undefined };
		} catch (err) {
			return {
				bundle: undefined,
				configError: err instanceof ConfigError ? err.message : String(err),
			};
		}
	}, [setupAttempt]);

	if (!bundle) {
		// ConfigError is the "no provider configured" path — show the
		// first-run wizard so new users have a guided way in. Anything
		// else is a real error and shouldn't prompt for credentials.
		if (configError !== undefined) {
			return <FirstRunSetup onDone={() => setSetupAttempt((n) => n + 1)} onQuit={exit} />;
		}
		return (
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				<Text bold color="red">
					configuration error
				</Text>
				<Box marginTop={1}>
					<Text>(unknown — see logs)</Text>
				</Box>
				<ExitOnCtrlC onExit={exit} />
			</Box>
		);
	}

	return <ChatApp bundle={bundle} onExit={exit} />;
}

interface ChatAppProps {
	bundle: AgentBundle;
	onExit: () => void;
}

function ChatApp({ bundle, onExit }: ChatAppProps) {
	const [state, dispatch] = useReducer(
		reducer,
		initialState(
			{ provider: bundle.model.provider, id: bundle.model.id, name: bundle.model.name },
			bundle.resumedMessages,
		),
	);
	const [permRequest, setPermRequest] = useState<PermissionRequest | undefined>(bundle.permissions.current());
	const [userQuery, setUserQuery] = useState<UserQuery | undefined>(bundle.userQueries.current());
	const [compactionState, setCompactionState] = useState(bundle.compactionMonitor.current());
	const [statusLines, setStatusLines] = useState<string[]>([]);
	// Cap the buffer so noisy emits (long /help, many !cmds) don't grow
	// the status pane indefinitely. 50 rows ≈ a screen on most terms.
	const appendStatus = (line: string) =>
		setStatusLines((prev) => {
			const next = [...prev, line];
			return next.length > 50 ? next.slice(next.length - 50) : next;
		});
	const [tasks, setTasks] = useState<readonly Task[]>(() => bundle.toolContext.tasks.list());
	const inputRef = useRef<InputHandle | null>(null);

	const registry = useMemo(() => {
		const reg = new CommandRegistry();
		reg.registerAll(BUILTIN_COMMANDS);
		return reg;
	}, []);

	const commandSuggestions = useMemo(
		() => registry.list().map((c) => ({ name: c.name, description: c.description })),
		[registry],
	);

	const historyStore = useMemo(() => new HistoryStore({ cwd: bundle.toolContext.cwd }), [bundle.toolContext.cwd]);
	const persistedHistory = useMemo(() => historyStore.load(), [historyStore]);

	const inputHistory = useMemo(() => {
		// Build the recall list from (persisted history) ++ (this-session prompts),
		// in chronological order. Persisted gives the user prior runs to recall;
		// this-session ensures their most recent prompt is at the top of ↑.
		const out: string[] = [...persistedHistory];
		for (const m of state.messages) {
			if (m.role !== "user") continue;
			const text = typeof m.content === "string" ? m.content : extractUserText(m.content);
			if (text.trim().length === 0) continue;
			if (out[out.length - 1] === text) continue;
			out.push(text);
		}
		return out;
	}, [state.messages, persistedHistory]);

	useCoalescedAgentEvents(bundle, dispatch);

	useEffect(() => {
		return bundle.permissions.subscribe((req) => setPermRequest(req));
	}, [bundle]);

	useEffect(() => {
		return bundle.compactionMonitor.subscribe((s) => setCompactionState(s));
	}, [bundle]);

	useEffect(() => {
		return bundle.userQueries.subscribe((q) => setUserQuery(q));
	}, [bundle]);

	useEffect(() => {
		return bundle.toolContext.tasks.subscribe((snapshot) => setTasks(snapshot));
	}, [bundle]);

	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";

	const { suggestion, dismiss: dismissSuggestion } = usePromptSuggestion(bundle, state.status, state.messages.length);

	const handleSubmit = async (text: string) => {
		// `!cmd` runs a shell command directly without involving the LLM —
		// "I just want to check something real quick." We bypass the agent
		// loop entirely and inject the output as a synthetic user /
		// toolResult pair so it shows up in the transcript but doesn't end
		// up in the model's context.
		if (text.startsWith("!") && text.length > 1) {
			await runShellEscape(text.slice(1), bundle.toolContext.cwd, appendStatus);
			return;
		}

		// Slash commands first — they bypass the agent.
		if (text.startsWith("/")) {
			const result = await registry.dispatch(text, {
				bundle,
				state: state as ChatState,
				emit: appendStatus,
				clearDisplay: () => {
					dispatch({ type: "reset" });
					setStatusLines([]);
				},
				exit: onExit,
				registry,
			});
			if (result.handled) return;
		}

		// `@path` tokens auto-attach file contents to the prompt so the
		// user doesn't have to spend a tool turn just to put a file in
		// context. Anything that doesn't resolve falls through unchanged
		// — we don't want to silently transform a literal @-mention.
		const attachments = collectAttachments(text, bundle.toolContext.cwd);
		const augmentedText = attachments.length > 0 ? buildAttachmentPrompt(text, attachments) : text;
		if (attachments.length > 0) {
			appendStatus(`Attached: ${attachments.map((a) => a.relPath).join(", ")}`);
		}

		// Capture history-presence BEFORE the user-prompt dispatch — React's
		// batched updates mean state.messages won't reflect the new user message
		// in the same tick, but the router needs to know whether this is a
		// continuation (greeting fast-track) or a first message.
		const hadHistory = state.messages.some((m) => m.role === "assistant");
		dispatch({ type: "user-prompt", text });
		// Persist the raw user input (pre-attachment-augmentation) so ↑ in
		// future sessions recalls what they actually typed.
		historyStore.append(text);

		try {
			const route = await routeUserInput(bundle.glue, text, { hasHistory: hadHistory });
			if (route.kind === "chat") {
				dispatch({ type: "chat-reply", text: route.reply });
				return;
			}
			if (route.kind === "plan") {
				await runPlanFlow(bundle, text, {
					onReply: (replyText) => dispatch({ type: "chat-reply", text: replyText }),
					onError: (message) => dispatch({ type: "error", message }),
				});
				return;
			}
		} catch (err) {
			// If the router itself crashes, don't drop the request — run the agent.
			// We still log it as a non-fatal status line so users notice.
			appendStatus(`(router fell back to agent: ${err instanceof Error ? err.message : err})`);
		}

		bundle.agent.prompt(augmentedText).catch((err: unknown) => {
			dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
		});
	};

	// Ctrl-C semantics, in priority order:
	//   1. Open overlay (Permission, UserQuery) → dismiss it. Never trap
	//      the user behind a prompt with no escape.
	//   2. Agent busy → abort the turn. Stay in the app.
	//   3. Idle, input has typed text → wipe the input. Lets the user
	//      back out of a half-written prompt without having to backspace.
	//   4. Idle, input empty → post a "Press Ctrl-C again to exit" hint
	//      and arm the double-tap exit window.
	//
	// At any state, a second Ctrl-C within DOUBLE_TAP_MS exits cleanly —
	// "twice real fast" is universally understood as "I want out."
	//
	// 1000ms is "real fast" — wide enough that intentional double-taps
	// register, tight enough that mashing Ctrl-C twice while flustered
	// doesn't accidentally exit.
	const exitTimerRef = useMemo(() => ({ deadline: 0 }), []);
	const handleAbort = () => {
		const DOUBLE_TAP_MS = 1000;
		const now = Date.now();
		if (now < exitTimerRef.deadline) {
			onExit();
			return;
		}
		exitTimerRef.deadline = now + DOUBLE_TAP_MS;

		// Overlays first.
		if (permRequest) {
			bundle.permissions.respond(permRequest.id, "deny");
			if (busy) {
				bundle.agent.abort();
				dispatch({ type: "abort" });
			}
			return;
		}
		if (userQuery) {
			bundle.userQueries.cancel(userQuery.id);
			if (busy) {
				bundle.agent.abort();
				dispatch({ type: "abort" });
			}
			return;
		}

		if (busy) {
			bundle.agent.abort();
			dispatch({ type: "abort" });
			// No hint here — the abort itself is the feedback. The
			// exit window is set silently so a quick second tap still
			// gets the user out without confirmation theater.
			return;
		}

		// Idle with typed input → clear it, don't fall through to the
		// exit-hint branch. The user is bailing on a prompt, not the app.
		if (inputRef.current?.clearIfHasText()) return;

		appendStatus("Press Ctrl-C again to exit.");
	};

	// Top-level Ctrl-C capture. Fires regardless of which child component
	// is mounted (Input, Permission, UserQuery) so the user always has a
	// way out. The per-component handlers stay for their other shortcuts
	// (Esc to deny, etc.) but Ctrl-C now routes through here.
	useInput((input, key) => {
		if (key.ctrl && input === "c") handleAbort();
	});

	return (
		<Box flexDirection="column">
			{state.messages.length === 0 && !state.streaming ? (
				<Welcome
					modelName={bundle.model.name}
					source={bundle.source}
					cwd={bundle.toolContext.cwd}
					resumedFrom={bundle.resumedFrom}
				/>
			) : (
				<Box paddingX={1} paddingY={0} marginBottom={1}>
					<Text bold color="cyan">
						codebase
					</Text>
					<Text dimColor> · {bundle.model.name} Model</Text>
				</Box>
			)}
			<MessageList messages={state.messages} streaming={state.streaming} tools={state.tools} />
			{compactionState.active ? <CompactionBanner state={compactionState} /> : null}
			<ToolPanel tools={state.tools} />
			<TaskPanel tasks={tasks} />
			{statusLines.length > 0 ? (
				<Box flexDirection="column" paddingX={1} marginBottom={1}>
					{statusLines.map((line, i) => (
						<Text key={`${i}-${line.slice(0, 8)}`} dimColor>
							{line}
						</Text>
					))}
				</Box>
			) : null}
			<Status state={state} cwd={bundle.toolContext.cwd} />
			{permRequest ? (
				<Permission
					request={permRequest}
					onRespond={(choice) => bundle.permissions.respond(permRequest.id, choice)}
				/>
			) : userQuery ? (
				<UserQueryView
					query={userQuery}
					onAnswer={(answer) => bundle.userQueries.respond(userQuery.id, answer)}
					onCancel={() => bundle.userQueries.cancel(userQuery.id)}
				/>
			) : (
				<Input
					ref={inputRef}
					disabled={busy}
					onSubmit={handleSubmit}
					onAbort={handleAbort}
					commands={commandSuggestions}
					history={inputHistory}
					cwd={bundle.toolContext.cwd}
					suggestion={suggestion}
					onSuggestionDismiss={dismissSuggestion}
				/>
			)}
		</Box>
	);
}

/** Extract the user-visible text from a content array (image messages). */
function extractUserText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: { type?: string }) => b?.type === "text")
		.map((b: { text?: string }) => b.text ?? "")
		.join("");
}

function ExitOnCtrlC({ onExit }: { onExit: () => void }) {
	useEffect(() => {
		const handler = () => onExit();
		process.on("SIGINT", handler);
		return () => {
			process.off("SIGINT", handler);
		};
	}, [onExit]);
	return null;
}
