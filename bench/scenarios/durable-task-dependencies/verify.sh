#!/bin/sh
set -e

npm test

if [ -z "$CODEBASE_BENCH_AGENT_JSON" ] || [ ! -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	echo "FAIL: CODEBASE_BENCH_AGENT_JSON missing" >&2
	exit 10
fi

if [ -z "$CODEBASE_BENCH_HOME" ] || [ ! -d "$CODEBASE_BENCH_HOME/.codebase/tasks" ]; then
	echo "FAIL: durable task directory missing" >&2
	exit 11
fi

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
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

const taskCalls = [...toolCalls("create_task"), ...toolCalls("update_task")];
const taskArgs = taskCalls.map((block) => args(block));
const argText = taskArgs.map((value) => JSON.stringify(value)).join("\n");

if (taskCalls.length < 3) {
	console.error(`FAIL: expected at least 3 task tool calls, saw ${taskCalls.length}`);
	process.exit(12);
}
if (!/"owner"\s*:\s*"main-agent"/.test(argText)) {
	console.error("FAIL: task tool calls did not claim owner main-agent");
	process.exit(13);
}
if (!/(blocked_by|add_blocked_by|add_blocks)/.test(argText)) {
	console.error("FAIL: task tool calls did not express a blocker edge");
	process.exit(14);
}

const taskRoot = path.join(process.env.CODEBASE_BENCH_HOME, ".codebase", "tasks");
const taskFiles = [];
function walk(dir) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) walk(full);
		else if (name.endsWith(".json")) taskFiles.push(full);
	}
}
walk(taskRoot);

const tasks = taskFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
if (!tasks.some((task) => task.owner === "main-agent")) {
	console.error("FAIL: durable task files did not persist owner main-agent");
	process.exit(15);
}
if (!tasks.some((task) => (task.blockedBy || []).length > 0 || (task.blocks || []).length > 0)) {
	console.error("FAIL: durable task files did not persist blocker edges");
	process.exit(16);
}

console.log("durable task dependency use ok");
NODE
