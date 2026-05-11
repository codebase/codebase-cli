import { Box, Text, useApp } from "ink";
import { useEffect, useMemo, useReducer, useState } from "react";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import { initialState, reducer } from "../agent/events.js";
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
import { FirstRunSetup } from "./FirstRunSetup.js";
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
			return { bundle: createAgent(), configError: undefined as string | undefined };
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

	const inputHistory = useMemo(() => {
		const out: string[] = [];
		for (const m of state.messages) {
			if (m.role !== "user") continue;
			const text = typeof m.content === "string" ? m.content : extractUserText(m.content);
			if (text.trim().length === 0) continue;
			// Collapse adjacent duplicates so ↑↑↑ doesn't dwell on a repeat.
			if (out[out.length - 1] === text) continue;
			out.push(text);
		}
		return out;
	}, [state.messages]);

	useEffect(() => {
		const unsubscribe = bundle.subscribe((event) => {
			dispatch({ type: "agent-event", event });
		});
		return unsubscribe;
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

	const handleSubmit = async (text: string) => {
		// Slash commands first — they bypass the agent.
		if (text.startsWith("/")) {
			const result = await registry.dispatch(text, {
				bundle,
				state: state as ChatState,
				emit: (line: string) => setStatusLines((prev) => [...prev, line]),
				clearDisplay: () => dispatch({ type: "reset" }),
				exit: onExit,
				// Inject the registry so /help can list commands.
				// biome-ignore lint/suspicious/noExplicitAny: cross-cutting injection
				registry,
				// biome-ignore lint/suspicious/noExplicitAny: cross-cutting injection
			} as any);
			if (result.handled) return;
		}

		// Capture history-presence BEFORE the user-prompt dispatch — React's
		// batched updates mean state.messages won't reflect the new user message
		// in the same tick, but the router needs to know whether this is a
		// continuation (greeting fast-track) or a first message.
		const hadHistory = state.messages.some((m) => m.role === "assistant");
		dispatch({ type: "user-prompt", text });

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
			setStatusLines((prev) => [
				...prev,
				`(router fell back to agent: ${err instanceof Error ? err.message : err})`,
			]);
		}

		bundle.agent.prompt(text).catch((err: unknown) => {
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

	const handleAbort = () => {
		if (busy) {
			bundle.agent.abort();
			dispatch({ type: "abort" });
		} else {
			onExit();
		}
	};

	return (
		<Box flexDirection="column">
			{state.messages.length === 0 && !state.streaming ? (
				<Welcome modelName={bundle.model.name} source={bundle.source} cwd={bundle.toolContext.cwd} />
			) : (
				<Box paddingX={1} paddingY={0} marginBottom={1}>
					<Text bold color="cyan">
						codebase
					</Text>
					<Text dimColor>
						{" "}
						· {bundle.model.name} ({bundle.source})
					</Text>
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
