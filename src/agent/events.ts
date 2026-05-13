import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type ChatState, EMPTY_USAGE, type ToolExecution } from "../types.js";

export type Action =
	| { type: "agent-event"; event: AgentEvent }
	| { type: "user-prompt"; text: string }
	| { type: "chat-reply"; text: string }
	| { type: "abort" }
	| { type: "error"; message: string }
	| { type: "reset" };

export function initialState(model: ChatState["model"]): ChatState {
	return {
		messages: [],
		tools: new Map(),
		status: "idle",
		usage: EMPTY_USAGE,
		model,
	};
}

export function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "user-prompt": {
			const userMsg: AgentMessage = {
				role: "user",
				content: action.text,
				timestamp: Date.now(),
			};
			return {
				...state,
				messages: [...state.messages, userMsg],
				status: "thinking",
				error: undefined,
				turnUsage: undefined,
			};
		}

		case "chat-reply": {
			// Glue replied to a small-talk turn; we render it as a synthetic
			// assistant message but never feed it to pi-agent-core, so the
			// agent's actual context stays clean of meta-banter.
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: action.text }],
				api: "chat",
				provider: "chat",
				model: state.model.id,
				usage: EMPTY_USAGE,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			return { ...state, messages: [...state.messages, message], status: "idle" };
		}

		case "abort":
			return { ...state, status: "aborted", streaming: undefined };

		case "error":
			return { ...state, status: "error", error: action.message, streaming: undefined };

		case "reset":
			return initialState(state.model);

		case "agent-event":
			// When the user has aborted a turn, ignore the abandoned turn's
			// tail events that would flip status back to thinking/idle (and
			// thus re-disable the input). The next user-prompt action resets
			// status cleanly. Tool execution and message events still apply
			// so any in-flight spinners and partial messages settle visually.
			if (state.status === "aborted" && (action.event.type === "turn_end" || action.event.type === "agent_end")) {
				return state;
			}
			return applyAgentEvent(state, action.event);
	}
}

function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
	switch (event.type) {
		case "agent_start":
			return { ...state, status: "thinking" };

		case "turn_start":
			return { ...state, status: "thinking", streaming: undefined };

		case "message_start":
			if (event.message.role !== "assistant") return state;
			return { ...state, status: "streaming", streaming: event.message };

		case "message_update":
			if (event.message.role !== "assistant") return state;
			return { ...state, streaming: event.message };

		case "message_end": {
			const final = event.message;
			// User messages are added via the "user-prompt" action for immediate UI feedback.
			// Tool result messages flow through here so we capture them in source order.
			if (final.role === "user") return state;
			const turnUsage = "usage" in final ? (final.usage as Usage | undefined) : undefined;
			return {
				...state,
				messages: [...state.messages, final],
				streaming: undefined,
				turnUsage: turnUsage ?? state.turnUsage,
				usage: turnUsage ? mergeUsage(state.usage, turnUsage) : state.usage,
			};
		}

		case "tool_execution_start": {
			const exec: ToolExecution = {
				id: event.toolCallId,
				name: event.toolName,
				args: event.args,
				status: "running",
				startedAt: Date.now(),
			};
			const tools = new Map(state.tools);
			tools.set(exec.id, exec);
			return { ...state, status: "tool", tools };
		}

		case "tool_execution_update": {
			const tools = new Map(state.tools);
			const existing = tools.get(event.toolCallId);
			if (existing) {
				tools.set(event.toolCallId, { ...existing, result: stringifyResult(event.partialResult) });
			}
			return { ...state, tools };
		}

		case "tool_execution_end": {
			const tools = new Map(state.tools);
			const existing = tools.get(event.toolCallId);
			if (existing) {
				tools.set(event.toolCallId, {
					...existing,
					status: event.isError ? "error" : "done",
					endedAt: Date.now(),
					result: stringifyResult(event.result),
					error: event.isError ? stringifyResult(event.result) : undefined,
				});
			}
			return { ...state, tools };
		}

		case "turn_end":
			// Tool results are already appended via message_end events; just update status.
			return { ...state, status: "thinking" };

		case "agent_end":
			return { ...state, status: state.error ? "error" : "idle", streaming: undefined };

		default:
			return state;
	}
}

function mergeUsage(a: Usage, b: Usage): Usage {
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
