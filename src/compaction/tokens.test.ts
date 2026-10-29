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

	it("ignores usage — it measures the whole request, not the message", () => {
		expect(estimateMessageTokens(assistant("x", 12345))).toBeLessThan(15);
	});
});

describe("estimateTotalTokens", () => {
	it("anchors on the newest assistant usage and adds only later messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "a".repeat(38), timestamp: 0 },
			assistant("x", 100),
			{ role: "user", content: "a".repeat(38), timestamp: 0 },
		];
		expect(estimateTotalTokens(messages)).toBe(100 + estimateMessageTokens(messages[2]));
	});

	it("does not add up usage across assistant turns", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			assistant("a", 14_000),
			{ role: "user", content: "again", timestamp: 0 },
			assistant("b", 14_100),
		];
		expect(estimateTotalTokens(messages)).toBe(14_100);
	});

	it("never drops below the chars-based sum (resumed, uncompacted history)", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "a".repeat(3800), timestamp: 0 }, assistant("x", 50)];
		expect(estimateTotalTokens(messages)).toBeGreaterThan(1000);
	});

	it("falls back to the chars-based sum without usage", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "a".repeat(38), timestamp: 0 },
			assistant("hello world", 0),
		];
		expect(estimateTotalTokens(messages)).toBe(
			estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1]),
		);
	});
});

function assistant(text: string, totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "x",
		provider: "x",
		model: "x",
		usage: { ...ZERO_USAGE, totalTokens },
		stopReason: "stop",
		timestamp: 0,
	};
}

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
