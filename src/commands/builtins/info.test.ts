import { describe, expect, it } from "vitest";
import type { ChatState, ToolExecution } from "../../types.js";
import type { CommandContext } from "../types.js";
import { context } from "./info.js";

const usage = {
	input: 1000,
	output: 25,
	cacheRead: 200,
	cacheWrite: 0,
	totalTokens: 1225,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeCtx(): { ctx: CommandContext; emits: string[] } {
	const emits: string[] = [];
	const messages = [
		{ role: "user", content: "please inspect this project" },
		{
			role: "assistant",
			content: [{ type: "text", text: "a".repeat(800) }],
		},
		{
			role: "user",
			content: [{ type: "text", text: "[Conversation compacted - summary of previous work follows]\nsummary" }],
		},
	] as never[];
	const tools = new Map<string, ToolExecution>([
		["call-1", { id: "call-1", name: "shell", args: {}, status: "running", startedAt: 1 }],
		["call-2", { id: "call-2", name: "edit_file", args: {}, status: "error", startedAt: 1, endedAt: 2 }],
	]);
	const state = {
		messages,
		tools,
		status: "idle",
		usage,
		turnUsage: usage,
		model: { provider: "faux", id: "test-model", name: "Test Model" },
	} satisfies ChatState;
	const ctx = {
		state,
		emit: (text: string) => emits.push(text),
		bundle: {
			model: { contextWindow: 10_000 },
			agent: { state: { messages } },
			compaction: { threshold: () => 7500 },
			compactionMonitor: { current: () => ({ active: false, startedAt: null, messageCount: 0 }) },
			toolContext: {
				tasks: {
					list: () => [{ status: "completed" }, { status: "pending" }, { status: "cancelled" }],
				},
			},
			memory: { index: () => "- project fact\n- user preference\n" },
		},
	} as unknown as CommandContext;
	return { ctx, emits };
}

describe("/context", () => {
	it("shows context estimate, tasks, memory, tools, and compaction summaries", () => {
		const { ctx, emits } = makeCtx();

		context.handler("", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Context:");
		expect(emits[0]).toContain("used:       1,200 / 10,000 tokens");
		expect(emits[0]).toContain("estimate:   last model-reported input + streaming estimate");
		expect(emits[0]).toContain("compacts:   at 7,500 tokens");
		expect(emits[0]).toContain("messages:   3 agent / 3 display");
		expect(emits[0]).toContain("summaries:  1 compaction summary in context");
		expect(emits[0]).toContain("tasks:      1/3 complete, 1 open, 1 cancelled");
		expect(emits[0]).toContain("memory:     2 MEMORY.md index lines");
		expect(emits[0]).toContain("tools:      2 seen, 1 running, 1 error");
		expect(emits[0]).toContain("Largest messages:");
	});
});
