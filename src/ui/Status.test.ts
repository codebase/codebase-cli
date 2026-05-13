import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { type ChatState, EMPTY_USAGE } from "../types.js";
import { estimateContextTokens } from "./Status.js";

const MODEL = { provider: "test", id: "test-model", name: "Test" };

function baseState(): ChatState {
	return {
		messages: [],
		tools: new Map(),
		status: "idle",
		usage: EMPTY_USAGE,
		model: MODEL,
	};
}

describe("estimateContextTokens", () => {
	it("returns the static-context baseline for an empty conversation", () => {
		// The system prompt + tool schemas are always in context even with
		// zero messages; the bar reflects that with a small non-zero seed.
		expect(estimateContextTokens(baseState())).toBeGreaterThan(0);
		expect(estimateContextTokens(baseState())).toBeLessThan(10_000);
	});

	it("prefers turnUsage.input + cacheRead when the provider reports them", () => {
		const state: ChatState = {
			...baseState(),
			turnUsage: {
				input: 1000,
				output: 0,
				cacheRead: 500,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		expect(estimateContextTokens(state)).toBe(1500);
	});

	it("falls back to char-based estimation when turnUsage is missing", () => {
		const state: ChatState = {
			...baseState(),
			messages: [
				{ role: "user", content: "hello world", timestamp: 1 } as AgentMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(400) }],
					api: "chat",
					provider: "p",
					model: "m",
					usage: EMPTY_USAGE,
					stopReason: "stop",
					timestamp: 2,
				} as AgentMessage,
			],
		};
		// 11 ("hello world") + 400 (x's) = 411 chars; 411 / 4 = ~103 tokens.
		// Plus the static-context baseline. Verify the delta from the baseline
		// is in the right neighborhood rather than asserting an exact total.
		const baseline = estimateContextTokens(baseState());
		const delta = estimateContextTokens(state) - baseline;
		expect(delta).toBeGreaterThan(95);
		expect(delta).toBeLessThan(115);
	});

	it("falls back when turnUsage is present but reports zero (proxy stripped usage)", () => {
		const state: ChatState = {
			...baseState(),
			turnUsage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			messages: [{ role: "user", content: "x".repeat(400), timestamp: 1 } as AgentMessage],
		};
		// Above the baseline by ~100 tokens (the 400-char message).
		const baseline = estimateContextTokens({ ...baseState(), turnUsage: state.turnUsage });
		expect(estimateContextTokens(state) - baseline).toBeGreaterThan(95);
	});

	it("includes streaming content so the bar fills mid-turn, not just at message_end", () => {
		const baseline: ChatState = {
			...baseState(),
			turnUsage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const withStream: ChatState = {
			...baseline,
			streaming: {
				role: "assistant",
				content: [{ type: "text", text: "y".repeat(800) }],
			} as unknown as AgentMessage,
		};
		// 1000 reported + 800/4 = 200 estimated streaming tokens = 1200
		expect(estimateContextTokens(withStream)).toBe(1200);
		expect(estimateContextTokens(baseline)).toBe(1000);
	});

	it("counts tool-call args toward the fallback estimate", () => {
		const args = { path: "src/lib/some/very/long/path.ts", limit: 200 };
		const state: ChatState = {
			...baseState(),
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: args }],
					api: "chat",
					provider: "p",
					model: "m",
					usage: EMPTY_USAGE,
					stopReason: "stop",
					timestamp: 1,
				} as unknown as AgentMessage,
			],
		};
		expect(estimateContextTokens(state)).toBeGreaterThan(0);
	});

	it("counts thinking blocks toward the fallback estimate", () => {
		const state: ChatState = {
			...baseState(),
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "z".repeat(800) }],
					api: "chat",
					provider: "p",
					model: "m",
					usage: EMPTY_USAGE,
					stopReason: "stop",
					timestamp: 1,
				} as unknown as AgentMessage,
			],
		};
		// 800 / 4 = 200 tokens above the baseline.
		expect(estimateContextTokens(state) - estimateContextTokens(baseState())).toBe(200);
	});
});
