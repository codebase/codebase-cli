import { spawn } from "node:child_process";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Box, Text, useApp } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import { initialState, reducer } from "../agent/events.js";
import { generateSuggestion } from "../agent/prompt-suggestion.js";
import { routeUserInput } from "../agent/router.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { CommandRegistry } from "../commands/registry.js";
import type { PermissionRequest } from "../permissions/store.js";
import {
	buildAgentPrompt,
	generatePlan,
	generateQuestion,
	MAX_QUESTIONS,
	parseAnswer,
	revisePlan,
} from "../plan/flow.js";
import { ANSWER_START_BUILDING, type QAPair } from "../plan/types.js";
import type { Task } from "../tools/task-store.js";
import type { ChatState } from "../types.js";
import { type UserQuery, UserQueryCancelled } from "../user-queries/store.js";
import { buildAttachmentPrompt, collectAttachments } from "./attachments.js";
import { FirstRunSetup } from "./FirstRunSetup.js";
import { HistoryStore } from "./history-store.js";
import { Input } from "./Input.js";
import { MessageList } from "./MessageList.js";
import { Permission } from "./Permission.js";
import { Status } from "./Status.js";
import { TaskPanel } from "./TaskPanel.js";
import { ToolPanel } from "./ToolPanel.js";
import { UserQueryView } from "./UserQuery.js";
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
		initialState({ provider: bundle.model.provider, id: bundle.model.id, name: bundle.model.name }),
	);
	const [permRequest, setPermRequest] = useState<PermissionRequest | undefined>(bundle.permissions.current());
	const [userQuery, setUserQuery] = useState<UserQuery | undefined>(bundle.userQueries.current());
	const [statusLines, setStatusLines] = useState<string[]>([]);
	// Cap the buffer so noisy emits (long /help, many !cmds) don't grow
	// the status pane indefinitely. 50 rows ≈ a screen on most terms.
	const appendStatus = (line: string) =>
		setStatusLines((prev) => {
			const next = [...prev, line];
			return next.length > 50 ? next.slice(next.length - 50) : next;
		});
	const [tasks, setTasks] = useState<readonly Task[]>(() => bundle.toolContext.tasks.list());

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

	// Coalesce high-frequency streaming events (per-token assistant updates
	// and per-chunk tool stdout) to one React commit per frame instead of
	// per event. Pi-agent-core emits one message_update per token, and a
	// fast model + long tool output can fire 100+ Hz — each dispatch runs
	// the full reducer + React tree diff + Yoga layout for everything on
	// screen. Throttling here is the single biggest cause of perceived
	// scroll/render jankiness; everything else (Static for finalized
	// messages, memoized children) is icing.
	//
	// Keyed coalescing: message_update has one slot, tool_execution_update
	// has one slot per tool id. Latest event wins. Non-coalesceable events
	// (message_start/end, tool_execution_start/end, turn_*, agent_*) flush
	// any pending updates first so ordering stays correct.
	const pendingRef = useRef<Map<string, AgentEvent>>(new Map());
	const flushTimerRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		const STREAM_FRAME_MS = 16; // ~60fps cap

		const flush = () => {
			flushTimerRef.current = null;
			if (pendingRef.current.size === 0) return;
			const events = [...pendingRef.current.values()];
			pendingRef.current.clear();
			for (const event of events) {
				dispatch({ type: "agent-event", event });
			}
		};

		const scheduleFlush = () => {
			if (flushTimerRef.current != null) return;
			flushTimerRef.current = setTimeout(flush, STREAM_FRAME_MS);
		};

		const unsubscribe = bundle.subscribe((event) => {
			if (event.type === "message_update") {
				pendingRef.current.set("msg", event);
				scheduleFlush();
				return;
			}
			if (event.type === "tool_execution_update") {
				pendingRef.current.set(`tool:${event.toolCallId}`, event);
				scheduleFlush();
				return;
			}
			// Any other event flushes the queue before dispatching so the
			// reducer sees pending streaming updates before the terminal
			// event (message_end, tool_execution_end, etc.).
			if (pendingRef.current.size > 0) {
				if (flushTimerRef.current != null) {
					clearTimeout(flushTimerRef.current);
					flushTimerRef.current = null;
				}
				flush();
			}
			dispatch({ type: "agent-event", event });
		});

		return () => {
			unsubscribe();
			if (flushTimerRef.current != null) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			pendingRef.current.clear();
		};
	}, [bundle]);

	useEffect(() => {
		return bundle.permissions.subscribe((req) => setPermRequest(req));
	}, [bundle]);

	useEffect(() => {
		return bundle.userQueries.subscribe((q) => setUserQuery(q));
	}, [bundle]);

	useEffect(() => {
		return bundle.toolContext.tasks.subscribe((snapshot) => setTasks(snapshot));
	}, [bundle]);

	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";

	// Inline prompt-suggestion ghost text. Schedules a single forecast
	// call when the agent goes idle; cancels the prior call on every new
	// state change so we never race two suggestions or show a stale one
	// after the user starts a new turn. 500ms debounce lets idle settle
	// (e.g. agent finishes, a quick status emit follows, we don't want to
	// fire twice). Disabled via env so users on metered BYOK providers
	// can opt out.
	const [suggestion, setSuggestion] = useState<string | null>(null);
	const suggestionAbortRef = useRef<AbortController | null>(null);
	useEffect(() => {
		// Always clear any active suggestion on state change — it was
		// computed for the previous turn and the user has moved on.
		setSuggestion(null);
		suggestionAbortRef.current?.abort();
		suggestionAbortRef.current = null;

		if (process.env.CODEBASE_NO_SUGGESTIONS === "1") return;
		if (state.status !== "idle") return;
		if (state.messages.length < 2) return;

		const ac = new AbortController();
		suggestionAbortRef.current = ac;
		const timer = setTimeout(async () => {
			if (ac.signal.aborted) return;
			try {
				const text = await generateSuggestion(bundle, { signal: ac.signal });
				if (ac.signal.aborted) return;
				if (text) setSuggestion(text);
			} catch {
				// Suggestion failures are silent — they're a nicety, not load-bearing.
			}
		}, 500);

		return () => {
			clearTimeout(timer);
			ac.abort();
			if (suggestionAbortRef.current === ac) suggestionAbortRef.current = null;
		};
	}, [bundle, state.status, state.messages.length]);

	const handleSubmit = async (text: string) => {
		// `!cmd` runs a shell command directly — the CC convention for
		// "I just want to check something real quick" without involving
		// the LLM. We bypass the agent loop entirely and inject the
		// output as a synthetic user / toolResult pair so it shows up in
		// the transcript but doesn't end up in the model's context.
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
				// Injecting the registry so /help can list commands without us
				// needing to thread it through the CommandContext type.
				registry,
			} as unknown as Parameters<typeof registry.dispatch>[1]);
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
				await runPlanFlow(text);
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

	/**
	 * Plan-mode flow:
	 *   1. Q&A loop (up to MAX_QUESTIONS, with the start-building escape).
	 *   2. Generate plan, render as a synthetic assistant message so the
	 *      user can read it in chat.
	 *   3. Approve / Revise / Cancel via the UserQuery primitive.
	 *   4. On approve, hand the original prompt + plan + Q&A to the agent
	 *      with the canonical buildAgentPrompt wrapper so weaker models
	 *      stick to the plan instead of re-planning mid-execution.
	 */
	const runPlanFlow = async (originalPrompt: string): Promise<void> => {
		const qaHistory: QAPair[] = [];
		try {
			for (let i = 0; i < MAX_QUESTIONS; i++) {
				const result = await generateQuestion(bundle.glue, originalPrompt, qaHistory, i);
				if (result.done || !result.question) break;
				const q = result.question;
				const optionLabels = q.options?.map((o) => o.label);
				const answer = await bundle.userQueries.ask({
					question: q.question,
					options: optionLabels,
					placeholder: optionLabels ? `1-${optionLabels.length}, or type a free-form answer` : undefined,
				});
				const resolved = parseAnswer(answer, q);
				if (resolved === ANSWER_START_BUILDING) break;
				qaHistory.push({ question: q.question, answer: resolved });
			}

			let plan = await generatePlan(bundle.glue, originalPrompt, qaHistory);

			while (true) {
				dispatch({ type: "chat-reply", text: plan });
				const decision = await bundle.userQueries.ask({
					question: "Approve this plan and run it?",
					options: ["Yes — run it", "Revise", "Cancel"],
				});
				const choice = matchOption(decision, ["Yes — run it", "Revise", "Cancel"]);
				if (choice === "Yes — run it") {
					const finalPrompt = buildAgentPrompt(originalPrompt, plan, qaHistory);
					bundle.agent.prompt(finalPrompt).catch((err: unknown) => {
						dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
					});
					return;
				}
				if (choice === "Cancel") {
					dispatch({ type: "chat-reply", text: "(plan cancelled)" });
					return;
				}
				const feedback = await bundle.userQueries.ask({
					question: "What should change about the plan?",
					placeholder: "describe the revision",
				});
				plan = await revisePlan(bundle.glue, plan, feedback);
			}
		} catch (err) {
			if (err instanceof UserQueryCancelled) {
				dispatch({ type: "chat-reply", text: "(plan cancelled)" });
				return;
			}
			dispatch({
				type: "error",
				message: `plan flow failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	};

	// Ctrl-C semantics:
	//   • While the agent is busy: abort the turn. Stays in the app.
	//   • A second Ctrl-C within DOUBLE_TAP_MS exits, regardless of
	//     whether the previous press aborted or just landed a hint.
	//     "Twice real fast" is universally understood as "I want out."
	//   • While idle: first press posts a hint + arms the exit window.
	//
	// 1000ms is "real fast" — wide enough that intentional double-taps
	// register, tight enough that mashing Ctrl-C twice while flustered
	// doesn't accidentally exit. Tunable here if testers want it longer.
	const exitTimerRef = useMemo(() => ({ deadline: 0 }), []);
	const handleAbort = () => {
		const DOUBLE_TAP_MS = 1000;
		const now = Date.now();
		if (now < exitTimerRef.deadline) {
			onExit();
			return;
		}
		exitTimerRef.deadline = now + DOUBLE_TAP_MS;
		if (busy) {
			bundle.agent.abort();
			dispatch({ type: "abort" });
			// No hint here — the abort itself is the feedback. The
			// exit window is set silently so a quick second tap still
			// gets the user out without confirmation theater.
			return;
		}
		appendStatus("Press Ctrl-C again to exit.");
	};

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
					disabled={busy}
					onSubmit={handleSubmit}
					onAbort={handleAbort}
					commands={commandSuggestions}
					history={inputHistory}
					cwd={bundle.toolContext.cwd}
					suggestion={suggestion}
					onSuggestionDismiss={() => setSuggestion(null)}
				/>
			)}
		</Box>
	);
}

/**
 * Run a one-shot `!command` and append its output to the status lines.
 * This is intentionally divorced from the agent's shell tool — the
 * agent's tool is for tool-use turns, this is a CLI escape so the user
 * can `!git status` without spending a turn. Output is capped at 32 KB
 * to keep the transcript from drowning.
 */
async function runShellEscape(command: string, cwd: string, emit: (line: string) => void): Promise<void> {
	emit(`! ${command}`);
	return new Promise<void>((resolve) => {
		const child = spawn(command, { shell: true, cwd, env: process.env });
		let buffer = "";
		const MAX = 32 * 1024;
		const onChunk = (chunk: Buffer) => {
			if (buffer.length >= MAX) return;
			buffer += chunk.toString("utf8").slice(0, MAX - buffer.length);
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("close", (code) => {
			const trimmed = buffer.trim();
			if (trimmed.length === 0) {
				emit(code === 0 ? "(no output)" : `(exit ${code})`);
			} else {
				const lines = trimmed.split("\n").slice(0, 60);
				for (const line of lines) emit(line);
				if (code !== 0) emit(`(exit ${code})`);
			}
			resolve();
		});
		child.on("error", (err) => {
			emit(`! ${err.message}`);
			resolve();
		});
	});
}

/** Extract the user-visible text from a content array (image messages). */
function extractUserText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: { type?: string }) => b?.type === "text")
		.map((b: { text?: string }) => b.text ?? "")
		.join("");
}

/**
 * Resolve a user's typed answer to one of the supplied options.
 * Accepts the option label (case-insensitive), a 1-based index,
 * or the leading word of the label. Falls back to the raw input
 * if nothing matches — caller decides what to do with that.
 */
function matchOption(answer: string, options: string[]): string {
	const trimmed = answer.trim();
	const idx = Number.parseInt(trimmed, 10);
	if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
		return options[idx - 1];
	}
	const lower = trimmed.toLowerCase();
	for (const option of options) {
		if (option.toLowerCase() === lower) return option;
		if (option.toLowerCase().startsWith(lower) && lower.length >= 3) return option;
	}
	return trimmed;
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
