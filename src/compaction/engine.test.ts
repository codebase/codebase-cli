import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { GlueClient } from "../glue/client.js";
import { CompactionEngine, extractFileOps, findSafeSplit } from "./engine.js";
import { contextWindow, estimateTotalTokens } from "./tokens.js";

function fakeGlue(reply: string): GlueClient {
	return { fast: vi.fn(async () => reply), smart: vi.fn(async () => reply) } as unknown as GlueClient;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "x",
		provider: "x",
		model: "x",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolCallMessage(toolName: string, id: string, args: unknown): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: toolName, arguments: args as Record<string, unknown> }],
		api: "x",
		provider: "x",
		model: "x",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResultMessage(id: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

describe("contextWindow", () => {
	it("returns the canonical window for known providers", () => {
		expect(contextWindow("claude-sonnet-4-6")).toBe(200_000);
		expect(contextWindow("gpt-4o")).toBe(128_000);
		expect(contextWindow("gemini-2.5-pro")).toBe(1_000_000);
	});

	it("falls back to 128K for unknown ids", () => {
		expect(contextWindow("totally-made-up-9000")).toBe(128_000);
	});
});

describe("findSafeSplit", () => {
	it("returns the desired index when nothing is unresolved there", () => {
		const messages = [userMessage("a"), assistantMessage("b"), userMessage("c"), assistantMessage("d")];
		expect(findSafeSplit(messages, 2)).toBe(2);
	});

	it("backtracks when splitting between toolCall and toolResult", () => {
		const messages = [
			userMessage("hi"),
			toolCallMessage("read_file", "tc1", { path: "a.ts" }),
			toolResultMessage("tc1", "read_file", "contents"),
			userMessage("ok"),
		];
		// Asking to split at index 2 (between toolCall and result) should
		// move backwards to index 1.
		expect(findSafeSplit(messages, 2)).toBe(1);
	});

	it("backtracks all the way to 0 if every position is unsafe", () => {
		// Pathological: only toolCall + result, no safe boundaries between them.
		const messages = [
			toolCallMessage("read_file", "tc1", { path: "a.ts" }),
			toolResultMessage("tc1", "read_file", "ok"),
		];
		expect(findSafeSplit(messages, 1)).toBe(0);
	});

	it("returns 0 when all messages are recent", () => {
		expect(findSafeSplit([], 0)).toBe(0);
	});
});

describe("extractFileOps", () => {
	it("collects reads and writes from assistant tool calls", () => {
		const messages = [
			toolCallMessage("read_file", "tc1", { path: "src/a.ts" }),
			toolResultMessage("tc1", "read_file", ""),
			toolCallMessage("edit_file", "tc2", { path: "src/a.ts", old_string: "x", new_string: "y" }),
			toolResultMessage("tc2", "edit_file", ""),
			toolCallMessage("write_file", "tc3", { path: "src/b.ts", content: "x" }),
			toolResultMessage("tc3", "write_file", ""),
		];
		const details = extractFileOps(messages);
		expect(details.readFiles).toEqual(["src/a.ts"]);
		expect(details.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("ignores tool calls without a path argument", () => {
		const messages = [toolCallMessage("shell", "tc1", { command: "ls" }), toolResultMessage("tc1", "shell", "")];
		expect(extractFileOps(messages)).toMatchObject({ readFiles: [], modifiedFiles: [] });
	});
});

describe("CompactionEngine", () => {
	it("needsCompaction is false for short transcripts", () => {
		const engine = new CompactionEngine({ glue: fakeGlue("summary"), modelId: "claude-sonnet-4-6" });
		const messages = [userMessage("hi"), assistantMessage("hi back")];
		expect(engine.needsCompaction(messages)).toBe(false);
	});

	it("needsCompaction triggers above the configured threshold ratio", () => {
		const engine = new CompactionEngine({
			glue: fakeGlue("summary"),
			modelId: "claude-sonnet-4-6",
			thresholdRatio: 0.0001, // ~20 tokens
		});
		const messages = Array.from({ length: 5 }, () => userMessage("a long-ish message line".repeat(2)));
		expect(estimateTotalTokens(messages)).toBeGreaterThan(20);
		expect(engine.needsCompaction(messages)).toBe(true);
	});

	it("compact returns the original transcript when shorter than keepRecent", async () => {
		const engine = new CompactionEngine({
			glue: fakeGlue("summary"),
			modelId: "claude-sonnet-4-6",
			keepRecent: 8,
		});
		const messages = [userMessage("a"), assistantMessage("b")];
		const result = await engine.compact(messages);
		expect(result.messages).toEqual(messages);
		expect(result.details.collapsedMessageCount).toBe(0);
	});

	it("compact replaces the older slice with summary + ack", async () => {
		const engine = new CompactionEngine({
			glue: fakeGlue("Summary text here."),
			modelId: "claude-sonnet-4-6",
			keepRecent: 2,
		});
		const messages = [
			userMessage("first"),
			assistantMessage("first reply"),
			userMessage("second"),
			assistantMessage("second reply"),
			userMessage("third"),
			assistantMessage("third reply"),
		];
		const result = await engine.compact(messages);
		expect(result.details.collapsedMessageCount).toBeGreaterThan(0);
		expect(result.details.summary).toContain("Summary text here.");
		expect(result.messages.length).toBeLessThan(messages.length);
		// First message should be the user-summary container
		expect(result.messages[0].role).toBe("user");
		const text = (result.messages[0].content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("compacted");
		expect(text).toContain("Summary text here.");
	});

	it("compact populates readFiles and modifiedFiles in details", async () => {
		const engine = new CompactionEngine({
			glue: fakeGlue("..."),
			modelId: "claude-sonnet-4-6",
			keepRecent: 2,
		});
		const messages = [
			userMessage("setup"),
			toolCallMessage("read_file", "tc1", { path: "old.ts" }),
			toolResultMessage("tc1", "read_file", ""),
			toolCallMessage("edit_file", "tc2", { path: "old.ts", old_string: "x", new_string: "y" }),
			toolResultMessage("tc2", "edit_file", ""),
			assistantMessage("done with old.ts"),
			userMessage("new ask"),
			assistantMessage("on it"),
		];
		const result = await engine.compact(messages);
		expect(result.details.readFiles).toContain("old.ts");
		expect(result.details.modifiedFiles).toContain("old.ts");
	});

	it("compact survives glue summarization failures with a non-empty fallback summary", async () => {
		const failing = {
			fast: vi.fn(async () => ""),
			smart: vi.fn(async () => {
				throw new Error("network");
			}),
		} as unknown as GlueClient;
		const engine = new CompactionEngine({ glue: failing, modelId: "claude-sonnet-4-6", keepRecent: 1 });
		const messages = [
			userMessage("a"),
			assistantMessage("b"),
			userMessage("c"),
			assistantMessage("d"),
			userMessage("e"),
		];
		const result = await engine.compact(messages);
		expect(result.details.summary).toMatch(/summarization failed/);
	});

	it("microcompact clears stale tool-result content without a glue call", () => {
		const glue = fakeGlue("should not be called");
		const engine = new CompactionEngine({ glue, modelId: "claude-sonnet-4-6" });
		const big = "x".repeat(4000);
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(toolCallMessage("read_file", `tc${i}`, { path: `f${i}.ts` }));
			messages.push(toolResultMessage(`tc${i}`, "read_file", `${big} #${i}`));
		}
		const before = estimateTotalTokens(messages);
		const out = engine.microcompact(messages);
		expect(out.clearedCount).toBeGreaterThan(0);
		expect(out.tokensSaved).toBeGreaterThan(0);
		expect(estimateTotalTokens(out.messages)).toBeLessThan(before);
		// Microcompaction never summarizes — glue must not be touched.
		expect(glue.smart).not.toHaveBeenCalled();
	});
});
