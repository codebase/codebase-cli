#!/bin/sh
set -e

npm test

if [ -z "$CODEBASE_BENCH_AGENT_JSON" ] || [ ! -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	echo "FAIL: CODEBASE_BENCH_AGENT_JSON missing" >&2
	exit 10
fi

node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const agent = JSON.parse(fs.readFileSync(process.env.CODEBASE_BENCH_AGENT_JSON, "utf8"));
const policy = fs.readFileSync("src/contextPolicy.mjs", "utf8");
const handoff = fs.readFileSync("docs/context-handoff.md", "utf8");
const combined = `${policy}\n${handoff}`;

for (const value of [
	"aurora-lattice",
	"Priya Raman",
	"CONTEXT_GUARDIAN_PRESERVE=tasks+memory",
	"7",
	"0.25",
	"npm run rollback:guardian",
	"npm test",
]) {
	if (!combined.includes(value)) {
		console.error(`FAIL: missing current context-continuity value: ${value}`);
		process.exit(11);
	}
}
if (/cedar-loop|CONTEXT_GUARDIAN_PRESERVE=none|Noah Pike|rollback:legacy/.test(combined)) {
	console.error("FAIL: stale context-continuity values were used");
	process.exit(12);
}

const tools = [];
const argText = [];
for (const msg of agent.messages || []) {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
	for (const block of msg.content) {
		if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
		tools.push(block.name);
		argText.push(JSON.stringify(block.arguments ?? block.args ?? block.input ?? {}));
	}
}
if (!tools.includes("create_task") || !tools.includes("update_task")) {
	console.error(`FAIL: expected task checklist tools, saw: ${tools.join(", ") || "(none)"}`);
	process.exit(13);
}
if (!argText.join("\n").includes("docs/incident-log.md")) {
	console.error("FAIL: agent transcript does not show incident-log inspection");
	process.exit(14);
}

const home = process.env.CODEBASE_BENCH_HOME || process.env.HOME;
const project = fs.realpathSync(process.env.CODEBASE_BENCH_PROJECT || process.cwd());
const hash = crypto.createHash("sha256").update(project).digest("hex").slice(0, 8);
const memoryDir = path.join(home, ".codebase", "projects", hash, "memory");
for (const name of [
	"context_guardian_runbook.md",
	"context_guardian_legacy.md",
	"context_guardian_palette.md",
	"MEMORY.md",
]) {
	if (!fs.existsSync(path.join(memoryDir, name))) {
		console.error(`FAIL: seeded memory missing: ${name}`);
		process.exit(15);
	}
}

if (agent.receipt) {
	const summary = agent.receipt.summary || {};
	if ((summary.completedTasks || 0) < 1 || (summary.completedTasksWithEvidence || 0) < 1) {
		console.error("FAIL: reliable receipt did not capture completed task evidence");
		process.exit(16);
	}
	if ((summary.verificationCount || 0) < 1 || (summary.verificationAfterLastMutationCount || 0) < 1) {
		console.error("FAIL: reliable receipt did not capture fresh verification");
		process.exit(17);
	}
}

console.log(`context continuity ok; tools=${tools.join(",") || "(none)"}`);
NODE
