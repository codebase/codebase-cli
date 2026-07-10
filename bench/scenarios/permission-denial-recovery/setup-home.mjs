#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEBASE_BENCH_HOME || process.env.HOME;
if (!home) {
	console.error("CODEBASE_BENCH_HOME/HOME is required");
	process.exit(1);
}

const codebaseDir = join(home, ".codebase");
mkdirSync(codebaseDir, { recursive: true });
const configPath = join(codebaseDir, "config.json");
let config = {};
if (existsSync(configPath)) {
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		config = {};
	}
}
const permissions = typeof config.permissions === "object" && config.permissions ? config.permissions : {};
const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
if (!deny.includes("shell:rm -rf*")) deny.push("shell:rm -rf*");
writeFileSync(
	configPath,
	`${JSON.stringify({ ...config, permissions: { ...permissions, deny } }, null, 2)}\n`,
	{ mode: 0o644 },
);
