#!/bin/sh
set -e

node test.mjs

if [ -z "$CODEBASE_BENCH_AGENT_JSON" ] || [ ! -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	echo "FAIL: CODEBASE_BENCH_AGENT_JSON missing" >&2
	exit 10
fi

node <<'NODE'
const fs = require("node:fs");
const agent = JSON.parse(fs.readFileSync(process.env.CODEBASE_BENCH_AGENT_JSON, "utf8"));

function toolCalls(name) {
	const out = [];
	for (const msg of agent.messages || []) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block?.type === "toolCall" && block.name === name) out.push(block);
		}
	}
	return out;
}

function args(block) {
	return block.arguments ?? block.args ?? block.input ?? {};
}

const creates = toolCalls("create_task");
const updates = toolCalls("update_task");
const inProgress = updates.filter((b) => args(b).status === "in_progress");
const completed = updates.filter((b) => args(b).status === "completed");
const taskText = [...creates, ...updates]
	.map((b) => JSON.stringify(args(b)))
	.join("\n")
	.toLowerCase();

if (creates.length < 4) {
	console.error(`FAIL: expected at least 4 create_task calls, saw ${creates.length}`);
	process.exit(11);
}
if (inProgress.length < 2) {
	console.error(`FAIL: expected visible task progress updates, saw ${inProgress.length} in_progress updates`);
	process.exit(12);
}
if (completed.length < 4) {
	console.error(`FAIL: expected task completion updates, saw ${completed.length} completed updates`);
	process.exit(13);
}
if (!/(verify|test|node test\.mjs)/.test(taskText)) {
	console.error("FAIL: task list did not include verification/test work");
	process.exit(14);
}

console.log("task tool use ok");
NODE
