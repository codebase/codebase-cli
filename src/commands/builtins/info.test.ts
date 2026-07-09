import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../memory/types.js";
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

function makeCtx(overrides: { turnUsage?: typeof usage; contextWindow?: number; compactAt?: number } = {}): {
	ctx: CommandContext;
	emits: string[];
} {
	const emits: string[] = [];
	const now = Date.now();
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
		turnUsage: overrides.turnUsage ?? usage,
		model: { provider: "faux", id: "test-model", name: "Test Model" },
	} satisfies ChatState;
	const memoryRecords: MemoryRecord[] = [
		{
			filename: "project_notes.md",
			name: "Project inspection",
			description: "Project context workflow",
			type: "project",
			source: "local project memory",
			createdAt: now,
			body: "When you inspect this project or edit src/app.ts, surface context UX gaps.",
			updatedAt: now,
			retrievalCount: 0,
		},
		{
			filename: "user_preference.md",
			name: "User response preference",
			description: "Final answer style",
			type: "user",
			source: "manual note",
			createdAt: now,
			body: "Keep launch-readiness summaries concise.",
			updatedAt: now,
			retrievalCount: 0,
		},
	];
	const ctx = {
		state,
		emit: (text: string) => emits.push(text),
		bundle: {
			model: { contextWindow: overrides.contextWindow ?? 10_000 },
			agent: { state: { messages } },
			compaction: { threshold: () => overrides.compactAt ?? 7500 },
			compactionMonitor: { current: () => ({ active: false, startedAt: null, messageCount: 0 }) },
			toolContext: {
				cwd: "/tmp/context-project",
				tasks: {
					list: () => [
						{
							id: "task-1",
							title: "Verify context command",
							status: "completed",
							blockedBy: [],
							owner: "main-agent",
						},
						{
							id: "task-2",
							title: "Explain context pressure",
							status: "pending",
							blockedBy: ["task-1"],
							owner: null,
						},
						{ id: "task-3", title: "Abandoned spike", status: "cancelled", blockedBy: [], owner: null },
					],
				},
			},
			memory: { index: () => "- project fact\n- user preference\n", list: () => memoryRecords },
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
		expect(emits[0]).toContain("model:      Test Model");
		expect(emits[0]).toContain("cwd:        /tmp/context-project");
		expect(emits[0]).toContain("used:       1,200 / 10,000 tokens");
		expect(emits[0]).toContain("estimate:   last model-reported input + streaming estimate");
		expect(emits[0]).toContain("compacts:   at 7,500 tokens");
		expect(emits[0]).toContain("pressure:   low; transcript still has plenty of room");
		expect(emits[0]).toContain("why:        6,300 tokens until compaction");
		expect(emits[0]).toContain("messages:   3 agent / 3 display");
		expect(emits[0]).toContain("summaries:  1 compaction summary in context");
		expect(emits[0]).toContain("tasks:      1/3 complete, 1 open, 1 cancelled");
		expect(emits[0]).toContain("memory:     2 MEMORY.md index lines");
		expect(emits[0]).toContain("2 memory files (user:1, project:1)");
		expect(emits[0]).toContain("1 matching latest prompt");
		expect(emits[0]).toContain("tools:      2 seen, 1 running, 1 error");
		expect(emits[0]).toContain("last summary: summary");
		expect(emits[0]).toContain("Largest messages:");
		expect(emits[0]).toContain("Use /context explain for details");
	});

	it("marks pressure high when close to compaction even below most of the model window", () => {
		const highUsage = { ...usage, input: 7000, cacheRead: 200, totalTokens: 7225 };
		const { ctx, emits } = makeCtx({ turnUsage: highUsage, compactAt: 7500 });

		context.handler("", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("used:       7,200 / 10,000 tokens");
		expect(emits[0]).toContain("pressure:   high; within 300 tokens of compaction");
		expect(emits[0]).toContain("why:        300 tokens until compaction (96.0% of threshold used)");
	});

	it("explains context pressure, recent messages, tasks, compaction, and inline files", () => {
		const { ctx, emits } = makeCtx();
		ctx.state.messages.push({
			role: "user",
			content:
				"Attached files (auto-inlined from @ mentions):\n\n### src/app.ts\n```\nconst app = true;\n```\n\n---\nfix @src/app.ts",
		} as never);
		ctx.state.messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-3", name: "read_file", arguments: { path: "src/app.ts" } }],
		} as never);

		context.handler("explain", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Context explanation:");
		expect(emits[0]).toContain("Budget:");
		expect(emits[0]).toContain("model: Test Model");
		expect(emits[0]).toContain("cwd: /tmp/context-project");
		expect(emits[0]).toContain("Top context contributors:");
		expect(emits[0]).toContain("tool calls: read_file");
		expect(emits[0]).toContain("Recent messages still in context:");
		expect(emits[0]).toContain("Open tasks:");
		expect(emits[0]).toContain("task-2 Explain context pressure [pending blocked_by:task-1]");
		expect(emits[0]).toContain("Memory:");
		expect(emits[0]).toContain("Available memory files: 2 (user:1, project:1)");
		expect(emits[0]).toContain("project_notes.md [project; source: local project memory");
		expect(emits[0]).toContain("Matching latest prompt (would be recalled on the next model turn):");
		expect(emits[0]).toContain("project_notes.md score:");
		expect(emits[0]).toContain("Memory reminder messages retained: none detected");
		expect(emits[0]).toContain("Last summary: summary");
		expect(emits[0]).toContain("Attached/imported files detected:");
		expect(emits[0]).toContain("src/app.ts");
		expect(emits[0]).toContain("What is at risk:");
		expect(emits[0]).toContain("Why pressure is this level:");
		expect(emits[0]).toContain("Good next moves:");
		expect(emits[0]).toContain("Reattach @files if exact contents matter after compaction.");
	});

	it("shows usage for unknown /context arguments", () => {
		const { ctx, emits } = makeCtx();

		context.handler("wat", ctx);

		expect(emits).toEqual(["Usage: /context [explain]"]);
	});
});
