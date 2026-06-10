import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { CLEARED_TOOL_RESULT, microcompact } from "./microcompact.js";

function toolResult(toolName: string, text: string, opts: { isError?: boolean } = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
		toolName,
		content: [{ type: "text", text }],
		isError: opts.isError ?? false,
		timestamp: 0,
	} as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function clearedText(m: AgentMessage): string | undefined {
	const content = (m as { content: Array<{ type: string; text?: string }> }).content;
	return content?.[0]?.text;
}

describe("microcompact", () => {
	it("clears stale compactable tool results, keeping the newest N", () => {
		const big = "x".repeat(5000);
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(user(`turn ${i}`));
			messages.push(toolResult("read_file", `${big} #${i}`));
		}
		const out = microcompact(messages, 3);
		// 10 read_file results, keep 3 → clear 7.
		expect(out.clearedCount).toBe(7);
		expect(out.tokensSaved).toBeGreaterThan(0);

		// The last 3 tool results retain their content; earlier ones are cleared.
		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		const clearedFlags = toolResults.map((m) => clearedText(m) === CLEARED_TOOL_RESULT);
		expect(clearedFlags.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
		expect(clearedFlags.slice(7)).toEqual([false, false, false]);
	});

	it("preserves message structure (same count, same order, tool results stay tool results)", () => {
		const messages: AgentMessage[] = [
			user("a"),
			toolResult("read_file", "x".repeat(2000)),
			toolResult("grep", "y".repeat(2000)),
			toolResult("read_file", "z".repeat(2000)),
		];
		const out = microcompact(messages, 1);
		expect(out.messages).toHaveLength(messages.length);
		expect(out.messages.map((m) => m.role)).toEqual(["user", "toolResult", "toolResult", "toolResult"]);
	});

	it("never clears errored tool results", () => {
		const messages: AgentMessage[] = [
			toolResult("shell", "boom", { isError: true }),
			toolResult("read_file", "x".repeat(2000)),
			toolResult("read_file", "y".repeat(2000)),
		];
		const out = microcompact(messages, 0);
		// keepRecent 0, but the error is exempt → only the two reads clear.
		expect(out.clearedCount).toBe(2);
		const err = out.messages[0];
		expect(clearedText(err)).toBe("boom");
	});

	it("ignores non-compactable tools (ask_user, tasks, config, git)", () => {
		const messages: AgentMessage[] = [
			toolResult("git_status", "branch info"),
			toolResult("create_task", "task body"),
			toolResult("config", "{}"),
		];
		const out = microcompact(messages, 0);
		expect(out.clearedCount).toBe(0);
		expect(out.tokensSaved).toBe(0);
	});

	it("is idempotent — a second pass clears nothing new", () => {
		const messages: AgentMessage[] = [
			toolResult("read_file", "x".repeat(3000)),
			toolResult("read_file", "y".repeat(3000)),
			toolResult("read_file", "z".repeat(3000)),
		];
		const first = microcompact(messages, 1);
		expect(first.clearedCount).toBe(2);
		const second = microcompact(first.messages, 1);
		expect(second.clearedCount).toBe(0);
	});

	it("returns the same array unchanged when nothing to clear", () => {
		const messages: AgentMessage[] = [user("hi"), toolResult("read_file", "small")];
		const out = microcompact(messages, 6);
		expect(out.clearedCount).toBe(0);
		expect(out.messages).toBe(messages);
	});
});
