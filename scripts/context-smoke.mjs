#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const distRoot = resolve("dist");
if (!existsSync(resolve(distRoot, "commands", "registry.js"))) {
	die("dist is missing; run `npm run build` before `node scripts/context-smoke.mjs`");
}

const [{ CommandRegistry }, { BUILTIN_COMMANDS }] = await Promise.all([
	import(`file://${resolve(distRoot, "commands", "registry.js")}`),
	import(`file://${resolve(distRoot, "commands", "builtins", "index.js")}`),
]);

const registry = new CommandRegistry();
registry.registerAll(BUILTIN_COMMANDS);

const now = Date.now();
const messages = [
	{ role: "user", content: "please inspect this project and explain context pressure" },
	{
		role: "assistant",
		content: [
			{
				type: "text",
				text: "I read a few large files and found the context visibility path.",
			},
		],
	},
	{
		role: "toolResult",
		toolName: "grep",
		content: [{ type: "text", text: "src/commands/builtins/info.ts\n".repeat(200) }],
	},
	{
		role: "user",
		content: "[Conversation compacted - summary of previous work follows]\nKept slash command state and context work.",
	},
	{
		role: "user",
		content:
			"Attached files (auto-inlined from @ mentions):\n\n### src/app.ts\n```\nexport const app = true;\n```\n\n---\nfinish @src/app.ts",
	},
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call-3", name: "read_file", arguments: { path: "src/app.ts" } }],
	},
];

const usage = {
	input: 18_000,
	output: 300,
	cacheRead: 2_000,
	cacheWrite: 0,
	totalTokens: 20_300,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const memoryRecords = [
	{
		filename: "context_visibility.md",
		name: "Context visibility work",
		description: "Show token pressure, memory, task state, and compaction state",
		type: "project",
		source: "context smoke fixture",
		createdAt: now,
		updatedAt: now,
		body: "When users inspect context pressure, include tasks, memory provenance, compaction summaries, and large messages.",
	},
	{
		filename: "answer_style.md",
		name: "Answer style",
		description: "Keep CLI status readable",
		type: "user",
		source: "context smoke fixture",
		createdAt: now,
		updatedAt: now,
		body: "Prefer concrete launch notes over vague reassurance.",
	},
];

const emitted = [];
const ctx = {
	state: {
		messages,
		tools: new Map([
			["call-1", { id: "call-1", name: "shell", args: {}, status: "running", startedAt: now }],
			["call-2", { id: "call-2", name: "edit_file", args: {}, status: "error", startedAt: now, endedAt: now + 1 }],
		]),
		status: "idle",
		usage,
		turnUsage: usage,
		model: { provider: "faux", id: "context-smoke", name: "Context Smoke" },
	},
	emit: (text) => emitted.push(text),
	clearDisplay: () => {},
	exit: () => {},
	registry,
	switchModel: async () => {},
	openModelPicker: () => {},
	switchSession: async () => {},
	bundle: {
		model: { provider: "faux", id: "context-smoke", name: "Context Smoke", contextWindow: 64_000 },
		source: "explicit",
		agent: { state: { messages } },
		compaction: { threshold: () => 48_000 },
		compactionMonitor: { current: () => ({ active: false, startedAt: null, messageCount: 0 }) },
		toolContext: {
			cwd: process.cwd(),
			tasks: {
				list: () => [
					{
						id: "task-1",
						title: "Wire context command",
						status: "completed",
						blockedBy: [],
						owner: "main-agent",
					},
					{
						id: "task-2",
						title: "Prove built CLI context smoke",
						status: "in_progress",
						blockedBy: ["task-1"],
						owner: "main-agent",
					},
				],
			},
		},
		memory: {
			index: () => "- context visibility work\n- answer style\n",
			list: () => memoryRecords,
		},
	},
};

await expectDispatch("/context", [
	"Context:",
	"used:",
	"estimate:",
	"compacts:",
	"messages:",
	"summaries:",
	"tasks:",
	"memory:",
	"tools:",
	"Largest messages:",
	"Use /context explain for details",
]);

await expectDispatch("/ctx explain", [
	"Context explanation:",
	"Budget:",
	"Top context contributors:",
	"Recent messages still in context:",
	"Open tasks:",
	"Memory:",
	"Available memory files:",
	"Matching latest prompt",
	"Compaction:",
	"Attached/imported files detected:",
	"src/app.ts",
	"What is at risk:",
]);

console.log("CONTEXT SMOKE OK");

async function expectDispatch(input, needles) {
	emitted.length = 0;
	const result = await registry.dispatch(input, ctx);
	if (!result.handled) die(`${input} was not handled`);
	if (emitted.length !== 1) die(`${input} emitted ${emitted.length} messages, expected 1`);
	const text = emitted[0];
	for (const needle of needles) {
		if (!text.includes(needle)) {
			die(`${input} output missing ${JSON.stringify(needle)}\n\n${text}`);
		}
	}
}

function die(message) {
	console.error(message);
	process.exit(1);
}
