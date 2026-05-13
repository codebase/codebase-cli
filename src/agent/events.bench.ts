import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { bench, describe } from "vitest";
import { type ChatState, EMPTY_USAGE } from "../types.js";
import { initialState, reducer } from "./events.js";

const MODEL = { provider: "test", id: "test-model", name: "Test" };

/**
 * Microbenchmarks for the reducer's hot paths. The streaming pipeline
 * funnels every assistant token and every tool stdout chunk through
 * this reducer — a 10ms regression here turns into perceptible
 * scroll/render jank in the TUI. Baselines printed by `npm run bench:micro`
 * are the contract; if these numbers degrade noticeably on a future PR,
 * something in the reducer needs investigation.
 */

function streamingMessage(text: string): AgentEvent {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	} as unknown as AgentEvent;
}

function toolStart(id: string): AgentEvent {
	return {
		type: "tool_execution_start",
		toolCallId: id,
		toolName: "read_file",
		args: { path: "src/x.ts" },
	} as unknown as AgentEvent;
}

function toolUpdate(id: string, n: number): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId: id,
		partialResult: `chunk ${n}`,
	} as unknown as AgentEvent;
}

describe("reducer hot paths", () => {
	bench("apply 1000 message_update events (assistant token stream)", () => {
		let s: ChatState = initialState(MODEL);
		// Seed a streaming message so message_update has something to overwrite.
		s = reducer(s, {
			type: "agent-event",
			event: {
				type: "message_start",
				message: { role: "assistant", content: [] },
			} as unknown as AgentEvent,
		});
		for (let i = 0; i < 1000; i++) {
			s = reducer(s, { type: "agent-event", event: streamingMessage(`token-${i}`) });
		}
	});

	bench("apply 1000 tool_execution_update events on a single tool (shell stdout)", () => {
		let s: ChatState = initialState(MODEL);
		s = reducer(s, { type: "agent-event", event: toolStart("t1") });
		for (let i = 0; i < 1000; i++) {
			s = reducer(s, { type: "agent-event", event: toolUpdate("t1", i) });
		}
	});

	bench("interleave 50 tools × 20 updates each (parallel tool burst)", () => {
		let s: ChatState = initialState(MODEL);
		for (let i = 0; i < 50; i++) {
			s = reducer(s, { type: "agent-event", event: toolStart(`t${i}`) });
		}
		for (let round = 0; round < 20; round++) {
			for (let i = 0; i < 50; i++) {
				s = reducer(s, { type: "agent-event", event: toolUpdate(`t${i}`, round) });
			}
		}
	});

	bench("user-prompt → agent-event sequence × 100 (full turn replay)", () => {
		let s: ChatState = initialState(MODEL);
		for (let turn = 0; turn < 100; turn++) {
			s = reducer(s, { type: "user-prompt", text: `prompt ${turn}` });
			s = reducer(s, {
				type: "agent-event",
				event: {
					type: "message_end",
					message: { role: "assistant", content: [], usage: EMPTY_USAGE },
				} as unknown as AgentEvent,
			});
		}
	});
});
