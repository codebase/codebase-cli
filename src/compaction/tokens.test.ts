import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { contextWindow, estimateMessageTokens, estimateTotalTokens } from "./tokens.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("estimateMessageTokens", () => {
	it("uses chars/3.8 fallback for messages without usage", () => {
		// 38 chars of content = ~10 tokens + 4 overhead = 14
		const message: AgentMessage = { role: "user", content: "a".repeat(38), timestamp: 0 };
		const tokens = estimateMessageTokens(message);
		expect(tokens).toBeGreaterThanOrEqual(13);
		expect(tokens).toBeLessThanOrEqual(15);
	});

	it("trusts provider-reported totalTokens over the heuristic when present", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			api: "x",
			provider: "x",
			model: "x",
			usage: { ...ZERO_USAGE, totalTokens: 12345 },
			stopReason: "stop",
			timestamp: 0,
		};
		expect(estimateMessageTokens(message)).toBe(12345);
	});

	it("falls through to the heuristic when usage.totalTokens is 0", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
			api: "x",
			provider: "x",
			model: "x",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		};
		// Heuristic: 11 chars / 3.8 = ~3 + 4 overhead = 7
		expect(estimateMessageTokens(message)).toBeGreaterThan(0);
		expect(estimateMessageTokens(message)).toBeLessThan(15);
	});

	it("estimateTotalTokens sums across messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "a".repeat(38), timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "x" }],
				api: "x",
				provider: "x",
				model: "x",
				usage: { ...ZERO_USAGE, totalTokens: 100 },
				stopReason: "stop",
				timestamp: 0,
			},
		];
		expect(estimateTotalTokens(messages)).toBeGreaterThanOrEqual(110);
	});
});

describe("contextWindow", () => {
	it("returns 200K for Claude families", () => {
		expect(contextWindow("claude-sonnet-4-6")).toBe(200_000);
		expect(contextWindow("claude-haiku-4-5")).toBe(200_000);
	});

	it("returns 1M for Gemini 2", () => {
		expect(contextWindow("gemini-2.5-pro")).toBe(1_000_000);
	});

	it("falls back to 128K for unknown ids", () => {
		expect(contextWindow("custom-model-xyz")).toBe(128_000);
	});
});
