import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type ChatState, EMPTY_USAGE } from "../types.js";
import { type Action, initialState, reducer } from "./events.js";

const MODEL = { provider: "test", id: "test-model", name: "Test Model" };

function freshState(): ChatState {
	return initialState(MODEL);
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 5,
		cacheWrite: 0,
		totalTokens: 35,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		...overrides,
	};
}

function dispatch(state: ChatState, action: Action): ChatState {
	return reducer(state, action);
}

describe("initialState", () => {
	it("creates an empty idle state", () => {
		const s = initialState(MODEL);
		expect(s.messages).toEqual([]);
		expect(s.tools.size).toBe(0);
		expect(s.status).toBe("idle");
		expect(s.usage).toEqual(EMPTY_USAGE);
		expect(s.model).toEqual(MODEL);
	});

	it("seeds messages from a resumed session so the UI shows prior turns", () => {
		const prior: AgentMessage[] = [
			{ role: "user", content: "from before", timestamp: 1 } as AgentMessage,
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "chat",
				provider: "p",
				model: "m",
				usage: EMPTY_USAGE,
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
		];
		const s = initialState(MODEL, prior);
		expect(s.messages).toHaveLength(2);
		expect(s.status).toBe("idle");
		// Copy, not reference — caller mutating the source array must not
		// reach into our state.
		expect(s.messages).not.toBe(prior);
	});
});

describe("reducer · user-prompt", () => {
	it("appends a user message and flips status to thinking", () => {
		const s = dispatch(freshState(), { type: "user-prompt", text: "hello" });
		expect(s.status).toBe("thinking");
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({ role: "user", content: "hello" });
	});

	it("clears any prior error and turnUsage", () => {
		const prior: ChatState = { ...freshState(), error: "bad", turnUsage: makeUsage() };
		const s = dispatch(prior, { type: "user-prompt", text: "retry" });
		expect(s.error).toBeUndefined();
		expect(s.turnUsage).toBeUndefined();
	});

	it("preserves prior messages", () => {
		const prior: ChatState = {
			...freshState(),
			messages: [{ role: "user", content: "first", timestamp: 1 } as AgentMessage],
		};
		const s = dispatch(prior, { type: "user-prompt", text: "second" });
		expect(s.messages).toHaveLength(2);
		expect((s.messages[0] as { content: string }).content).toBe("first");
	});
});

describe("reducer · chat-reply", () => {
	it("appends a synthetic assistant message and returns to idle", () => {
		const s = dispatch(freshState(), { type: "chat-reply", text: "hi back" });
		expect(s.status).toBe("idle");
		expect(s.messages).toHaveLength(1);
		const msg = s.messages[0] as { role: string; content: Array<{ type: string; text: string }> };
		expect(msg.role).toBe("assistant");
		expect(msg.content[0]).toEqual({ type: "text", text: "hi back" });
	});
});

describe("reducer · abort/error/reset", () => {
	it("abort sets status to aborted and clears streaming", () => {
		const prior: ChatState = {
			...freshState(),
			status: "streaming",
			streaming: { role: "assistant" } as AgentMessage,
		};
		const s = dispatch(prior, { type: "abort" });
		expect(s.status).toBe("aborted");
		expect(s.streaming).toBeUndefined();
	});

	it("error captures the message and clears streaming", () => {
		const prior: ChatState = { ...freshState(), streaming: { role: "assistant" } as AgentMessage };
		const s = dispatch(prior, { type: "error", message: "boom" });
		expect(s.status).toBe("error");
		expect(s.error).toBe("boom");
		expect(s.streaming).toBeUndefined();
	});

	it("reset returns to initial state while preserving model", () => {
		const prior: ChatState = {
			...freshState(),
			messages: [{ role: "user", content: "x", timestamp: 1 } as AgentMessage],
			status: "thinking",
		};
		const s = dispatch(prior, { type: "reset" });
		expect(s.messages).toEqual([]);
		expect(s.status).toBe("idle");
		expect(s.model).toEqual(MODEL);
	});
});

describe("reducer · agent-event lifecycle", () => {
	it("agent_start flips to thinking", () => {
		const s = dispatch(freshState(), { type: "agent-event", event: { type: "agent_start" } as AgentEvent });
		expect(s.status).toBe("thinking");
	});

	it("turn_start clears streaming", () => {
		const prior: ChatState = { ...freshState(), streaming: { role: "assistant" } as AgentMessage };
		const s = dispatch(prior, { type: "agent-event", event: { type: "turn_start" } as AgentEvent });
		expect(s.status).toBe("thinking");
		expect(s.streaming).toBeUndefined();
	});

	it("message_start sets streaming and flips to streaming status", () => {
		const event = {
			type: "message_start",
			message: { role: "assistant", content: [], api: "chat", provider: "p", model: "m" },
		} as unknown as AgentEvent;
		const s = dispatch(freshState(), { type: "agent-event", event });
		expect(s.status).toBe("streaming");
		expect(s.streaming).toBeDefined();
	});

	it("message_start ignores non-assistant roles", () => {
		const event = {
			type: "message_start",
			message: { role: "user", content: "x" },
		} as unknown as AgentEvent;
		const s = dispatch(freshState(), { type: "agent-event", event });
		expect(s.streaming).toBeUndefined();
	});

	it("message_update overwrites streaming with the latest snapshot", () => {
		const start = {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "h" }] },
		} as unknown as AgentEvent;
		const update = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
		} as unknown as AgentEvent;
		let s = dispatch(freshState(), { type: "agent-event", event: start });
		s = dispatch(s, { type: "agent-event", event: update });
		const streamed = s.streaming as unknown as { content: Array<{ text: string }> };
		expect(streamed.content[0].text).toBe("hello");
	});

	it("message_end appends, clears streaming, and merges usage when present", () => {
		const event = {
			type: "message_end",
			message: { role: "assistant", content: [], usage: makeUsage() },
		} as unknown as AgentEvent;
		const s = dispatch(freshState(), { type: "agent-event", event });
		expect(s.messages).toHaveLength(1);
		expect(s.streaming).toBeUndefined();
		expect(s.turnUsage?.totalTokens).toBe(35);
		expect(s.usage.totalTokens).toBe(35);
	});

	it("message_end ignores user-role finalizations (already handled by user-prompt)", () => {
		const event = {
			type: "message_end",
			message: { role: "user", content: "x" },
		} as unknown as AgentEvent;
		const s = dispatch(freshState(), { type: "agent-event", event });
		expect(s.messages).toHaveLength(0);
	});

	it("usage accumulates across multiple message_end events", () => {
		const ev1 = {
			type: "message_end",
			message: { role: "assistant", content: [], usage: makeUsage({ totalTokens: 10 }) },
		} as unknown as AgentEvent;
		const ev2 = {
			type: "message_end",
			message: { role: "assistant", content: [], usage: makeUsage({ totalTokens: 20 }) },
		} as unknown as AgentEvent;
		let s = dispatch(freshState(), { type: "agent-event", event: ev1 });
		s = dispatch(s, { type: "agent-event", event: ev2 });
		expect(s.usage.totalTokens).toBe(30);
	});

	it("turn_end flips back to thinking (next iteration may start)", () => {
		const prior: ChatState = { ...freshState(), status: "tool" };
		const s = dispatch(prior, { type: "agent-event", event: { type: "turn_end" } as AgentEvent });
		expect(s.status).toBe("thinking");
	});

	it("agent_end goes to idle when no error", () => {
		const prior: ChatState = { ...freshState(), status: "tool" };
		const s = dispatch(prior, { type: "agent-event", event: { type: "agent_end" } as AgentEvent });
		expect(s.status).toBe("idle");
	});

	it("agent_end goes to error when an error is set", () => {
		const prior: ChatState = { ...freshState(), error: "previously failed" };
		const s = dispatch(prior, { type: "agent-event", event: { type: "agent_end" } as AgentEvent });
		expect(s.status).toBe("error");
	});

	it("unknown event types pass state through unchanged", () => {
		const prior: ChatState = { ...freshState(), status: "thinking" };
		const s = dispatch(prior, {
			type: "agent-event",
			event: { type: "unknown_event_type" } as unknown as AgentEvent,
		});
		expect(s).toBe(prior);
	});
});

describe("reducer · tool execution lifecycle", () => {
	it("tool_execution_start adds a running entry and flips status to tool", () => {
		const event = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read_file",
			args: { path: "x.ts" },
		} as unknown as AgentEvent;
		const s = dispatch(freshState(), { type: "agent-event", event });
		expect(s.status).toBe("tool");
		const exec = s.tools.get("call-1");
		expect(exec).toMatchObject({ id: "call-1", name: "read_file", status: "running" });
		expect(exec?.startedAt).toBeGreaterThan(0);
	});

	it("tool_execution_update writes partial result without changing status", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "c",
				toolName: "shell",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_update",
				toolCallId: "c",
				partialResult: "partial output",
			} as unknown as AgentEvent,
		});
		expect(s.tools.get("c")?.result).toBe("partial output");
		expect(s.tools.get("c")?.status).toBe("running");
	});

	it("tool_execution_update on unknown id is a no-op", () => {
		const prior = freshState();
		const s = dispatch(prior, {
			type: "agent-event",
			event: {
				type: "tool_execution_update",
				toolCallId: "missing",
				partialResult: "x",
			} as unknown as AgentEvent,
		});
		expect(s.tools.size).toBe(0);
	});

	it("tool_execution_end marks done with result and endedAt", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "t",
				toolName: "shell",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t",
				result: "ok",
				isError: false,
			} as unknown as AgentEvent,
		});
		const exec = s.tools.get("t");
		expect(exec?.status).toBe("done");
		expect(exec?.result).toBe("ok");
		expect(exec?.endedAt).toBeGreaterThan(0);
		expect(exec?.error).toBeUndefined();
	});

	it("tool_execution_end marks error and copies result into error field", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "t",
				toolName: "shell",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t",
				result: "permission denied",
				isError: true,
			} as unknown as AgentEvent,
		});
		const exec = s.tools.get("t");
		expect(exec?.status).toBe("error");
		expect(exec?.error).toBe("permission denied");
	});

	it("stringifies non-string tool results", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "t",
				toolName: "glob",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t",
				result: { matches: ["a.ts", "b.ts"] },
				isError: false,
			} as unknown as AgentEvent,
		});
		expect(s.tools.get("t")?.result).toBe('{"matches":["a.ts","b.ts"]}');
	});

	it("null and undefined results stringify to empty string", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "t",
				toolName: "x",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t",
				result: null,
				isError: false,
			} as unknown as AgentEvent,
		});
		expect(s.tools.get("t")?.result).toBe("");
	});

	it("creates a fresh tools Map per update so React sees a new reference", () => {
		const start = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "a",
				toolName: "x",
				args: {},
			} as unknown as AgentEvent,
		});
		const before = start.tools;
		const after = dispatch(start, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "a",
				result: "",
				isError: false,
			} as unknown as AgentEvent,
		}).tools;
		expect(after).not.toBe(before);
	});
});

describe("reducer · usage merging", () => {
	it("sums every field component including cost subfields", () => {
		const a = makeUsage({
			input: 10,
			output: 20,
			cacheRead: 5,
			cacheWrite: 3,
			totalTokens: 38,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.03, total: 0.38 },
		});
		const b = makeUsage({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		});
		let s: ChatState = { ...freshState(), usage: a };
		const event = {
			type: "message_end",
			message: { role: "assistant", content: [], usage: b },
		} as unknown as AgentEvent;
		s = dispatch(s, { type: "agent-event", event });
		expect(s.usage.input).toBe(11);
		expect(s.usage.output).toBe(22);
		expect(s.usage.cacheRead).toBe(5);
		expect(s.usage.cacheWrite).toBe(3);
		expect(s.usage.totalTokens).toBe(41);
		expect(s.usage.cost.total).toBeCloseTo(0.41, 5);
	});

	it("leaves usage alone when message_end has no usage field", () => {
		const event = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		} as unknown as AgentEvent;
		const prior: ChatState = { ...freshState(), usage: makeUsage({ totalTokens: 100 }) };
		const s = dispatch(prior, { type: "agent-event", event });
		expect(s.usage.totalTokens).toBe(100);
	});
});

describe("reducer · post-abort event suppression", () => {
	it("ignores turn_end while status is aborted (would otherwise re-disable input)", () => {
		let s = dispatch(freshState(), { type: "agent-event", event: { type: "agent_start" } as AgentEvent });
		expect(s.status).toBe("thinking");
		s = dispatch(s, { type: "abort" });
		expect(s.status).toBe("aborted");
		// Abandoned turn's tail arrives — must NOT flip us to thinking.
		s = dispatch(s, { type: "agent-event", event: { type: "turn_end" } as AgentEvent });
		expect(s.status).toBe("aborted");
	});

	it("ignores agent_end while status is aborted", () => {
		const s = dispatch(
			{ ...freshState(), status: "aborted" },
			{
				type: "agent-event",
				event: { type: "agent_end" } as AgentEvent,
			},
		);
		expect(s.status).toBe("aborted");
	});

	it("a subsequent user-prompt clears the aborted state and starts a fresh turn", () => {
		const s = dispatch({ ...freshState(), status: "aborted" }, { type: "user-prompt", text: "try again" });
		expect(s.status).toBe("thinking");
	});

	it("still applies tool_execution_end while aborted so spinners clear visually", () => {
		let s = dispatch(freshState(), {
			type: "agent-event",
			event: {
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "shell",
				args: {},
			} as unknown as AgentEvent,
		});
		s = dispatch(s, { type: "abort" });
		expect(s.status).toBe("aborted");
		expect(s.tools.get("t1")?.status).toBe("running");
		s = dispatch(s, {
			type: "agent-event",
			event: {
				type: "tool_execution_end",
				toolCallId: "t1",
				result: "interrupted",
				isError: true,
			} as unknown as AgentEvent,
		});
		expect(s.tools.get("t1")?.status).toBe("error");
		// Status itself stays "aborted" — we don't let the abandoned turn flip it.
		expect(s.status).toBe("aborted");
	});
});

describe("reducer · model-switched", () => {
	it("replaces the model, clears tools/streaming/error, sets status idle, KEEPS messages", () => {
		const prior: ChatState = {
			...freshState(),
			messages: [{ role: "user", content: "preserved", timestamp: 1 } as AgentMessage],
			tools: new Map([["t1", { id: "t1", name: "shell", args: {}, status: "running", startedAt: 1 }]]),
			streaming: { role: "assistant" } as AgentMessage,
			status: "streaming",
			error: "old error",
		};
		const newModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" };
		const s = dispatch(prior, { type: "model-switched", model: newModel });
		expect(s.model).toEqual(newModel);
		expect(s.tools.size).toBe(0);
		expect(s.streaming).toBeUndefined();
		expect(s.status).toBe("idle");
		expect(s.error).toBeUndefined();
		// Transcript continues across model swap.
		expect(s.messages).toHaveLength(1);
	});
});
