#!/bin/sh
set -e

node test.mjs

for f in src/config.js src/server.js test.mjs; do
	if [ ! -f "$f" ]; then
		echo "FAIL: $f is missing" >&2
		exit 2
	fi
done

if ! grep -q "redacted" src/config.js; then
	echo "FAIL: redaction behavior does not appear to be implemented in src/config.js" >&2
	exit 3
fi

if [ -n "$CODEBASE_BENCH_AGENT_JSON" ] && [ -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	node <<'NODE'
const fs = require("node:fs");
const agent = JSON.parse(fs.readFileSync(process.env.CODEBASE_BENCH_AGENT_JSON, "utf8"));
const tools = [];
for (const msg of agent.messages || []) {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
	for (const block of msg.content) {
		if (block?.type === "toolCall" && typeof block.name === "string") tools.push(block.name);
	}
}
if (!tools.includes("read_file") && !tools.includes("grep") && !tools.includes("glob")) {
	console.error(`FAIL: expected code inspection before editing, saw tools: ${tools.join(", ") || "(none)"}`);
	process.exit(4);
}
if (!tools.includes("create_task") || !tools.includes("update_task")) {
	console.error(`FAIL: expected task checklist tools in complex issue, saw: ${tools.join(", ") || "(none)"}`);
	process.exit(5);
}
console.log("agent behavior ok");
NODE
fi

echo "ok"
