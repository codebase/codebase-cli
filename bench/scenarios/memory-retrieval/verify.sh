#!/bin/sh
set -e

if [ ! -f deployment-plan.md ]; then
	echo "FAIL: deployment-plan.md was not created" >&2
	exit 10
fi

if [ -z "$CODEBASE_BENCH_AGENT_JSON" ] || [ ! -f "$CODEBASE_BENCH_AGENT_JSON" ]; then
	echo "FAIL: CODEBASE_BENCH_AGENT_JSON missing" >&2
	exit 13
fi

node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const agent = JSON.parse(fs.readFileSync(process.env.CODEBASE_BENCH_AGENT_JSON, "utf8"));
const plan = fs.readFileSync("deployment-plan.md", "utf8");

for (const value of [
	"cobalt-sparrow",
	"NIMBUS_BILLING_V2=true",
	"Mira Chen",
	"npm run test:billing && npm run smoke:nimbus",
]) {
	if (!plan.includes(value)) {
		console.error(`FAIL: deployment plan missing ${value}`);
		process.exit(11);
	}
}
if (!/bench seed: release-ops fixture|nimbus_billing_deploy\.md/i.test(plan)) {
	console.error("FAIL: deployment plan does not identify the selected memory source");
	process.exit(12);
}
if (!/stale[: ]+(no|false)|not stale|non-stale|active runbook|updated\s+20\d{2}-\d{2}-\d{2}/i.test(plan)) {
	console.error("FAIL: plan does not indicate the selected memory was current/non-stale");
	process.exit(16);
}
if (/amber-river|NIMBUS_BILLING_V1=true|Marin Patel|test:legacy-billing|ops-blue|warm silver/i.test(plan)) {
	console.error("FAIL: plan used stale or unrelated distractor memory");
	process.exit(17);
}

const tools = [];
for (const msg of agent.messages || []) {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
	for (const block of msg.content) {
		if (block?.type === "toolCall" && typeof block.name === "string") tools.push(block.name);
	}
}

const home = process.env.CODEBASE_BENCH_HOME || process.env.HOME;
const project = fs.realpathSync(process.env.CODEBASE_BENCH_PROJECT || process.cwd());
const hash = crypto.createHash("sha256").update(project).digest("hex").slice(0, 8);
const memoryDir = path.join(home, ".codebase", "projects", hash, "memory");
for (const name of ["nimbus_billing_deploy.md", "nimbus_billing_legacy.md", "brand_palette.md", "MEMORY.md"]) {
	if (!fs.existsSync(path.join(memoryDir, name))) {
		console.error(`FAIL: seeded memory missing: ${name}`);
		process.exit(15);
	}
}

const readMemoryCount = tools.filter((name) => name === "read_memory").length;
console.log(`memory retrieval ok; read_memory=${readMemoryCount}; tools=${tools.join(",") || "(none)"}`);
NODE
