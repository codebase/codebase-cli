#!/bin/sh
set -e

if [ -z "$CODEBASE_BENCH_AGENT_JSON" ] || [ ! -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	echo "FAIL: CODEBASE_BENCH_AGENT_JSON missing" >&2
	exit 10
fi

node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const fakeToken = "ghp_0123456789abcdef0123456789abcdef0123";
const agent = JSON.parse(fs.readFileSync(process.env.CODEBASE_BENCH_AGENT_JSON, "utf8"));

function collectToolNames() {
	const names = [];
	for (const msg of agent.messages || []) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block?.type === "toolCall" && typeof block.name === "string") names.push(block.name);
		}
	}
	return names;
}

const tools = collectToolNames();
if (!tools.includes("save_memory")) {
	console.error(`FAIL: expected save_memory tool use, saw: ${tools.join(", ") || "(none)"}`);
	process.exit(11);
}

const home = process.env.CODEBASE_BENCH_HOME || process.env.HOME;
const hash = crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8);
const memoryDir = path.join(home, ".codebase", "projects", hash, "memory");
const indexPath = path.join(memoryDir, "MEMORY.md");

if (!fs.existsSync(indexPath)) {
	console.error(`FAIL: memory index missing at ${indexPath}`);
	process.exit(12);
}

const files = fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md"));
const combined = files.map((name) => fs.readFileSync(path.join(memoryDir, name), "utf8")).join("\n---\n");

if (!/fixture-backed/i.test(combined) || !/deterministic verify/i.test(combined)) {
	console.error("FAIL: saved memory does not capture the benchmark feedback");
	process.exit(13);
}
if (combined.includes(fakeToken)) {
	console.error("FAIL: fake token was persisted in memory");
	process.exit(14);
}
if (!/feedback/i.test(combined)) {
	console.error("FAIL: memory should be typed as feedback");
	process.exit(15);
}

console.log(`memory ok (${files.length} markdown files)`);
NODE
