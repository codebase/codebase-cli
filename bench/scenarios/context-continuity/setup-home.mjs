#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEBASE_BENCH_HOME || process.env.HOME;
const project = realpathSync(process.env.CODEBASE_BENCH_PROJECT || process.cwd());
if (!home) {
	console.error("CODEBASE_BENCH_HOME/HOME is required");
	process.exit(1);
}

const projectHash = createHash("sha256").update(project).digest("hex").slice(0, 8);
const memoryDir = join(home, ".codebase", "projects", projectHash, "memory");
mkdirSync(memoryDir, { recursive: true });

const freshUpdatedAt = new Date().toISOString();

writeMemory("context_guardian_runbook.md", {
	name: "Context Guardian current runbook",
	description: "Current Context Guardian release continuity runbook",
	type: "project",
	source: "bench seed: context continuity fixture",
	createdAt: "2026-07-07T00:00:00.000Z",
	updatedAt: freshUpdatedAt,
	body: [
		"Release codename: aurora-lattice",
		"Owner: Priya Raman",
		"Preserve flag: CONTEXT_GUARDIAN_PRESERVE=tasks+memory",
		"Verification command: npm test",
		"Staleness: current / not stale",
	].join("\n"),
});

writeMemory("context_guardian_legacy.md", {
	name: "Legacy Context Guardian tabletop",
	description: "Stale Context Guardian tabletop values retained for audit history",
	type: "project",
	source: "bench seed: stale context fixture",
	createdAt: "2026-06-20T00:00:00.000Z",
	updatedAt: "2026-06-28T00:00:00.000Z",
	body: [
		"Release codename: cedar-loop",
		"Owner: Noah Pike",
		"Preserve flag: CONTEXT_GUARDIAN_PRESERVE=none",
		"Verification command: npm run test:legacy-context",
		"Staleness: stale / do not use for current release",
	].join("\n"),
});

writeMemory("context_guardian_palette.md", {
	name: "Context Guardian palette reference",
	description: "Unrelated visual notes for a Context Guardian status page",
	type: "reference",
	source: "bench seed: unrelated context fixture",
	createdAt: "2026-07-07T00:00:00.000Z",
	updatedAt: freshUpdatedAt,
	body: [
		"Primary color: orbital blue",
		"Accent color: lattice green",
		"This memory is unrelated to release policy values.",
	].join("\n"),
});

writeFileSync(
	join(memoryDir, "MEMORY.md"),
	[
		"- [Context Guardian current runbook](context_guardian_runbook.md) - Current Context Guardian release continuity runbook",
		"- [Legacy Context Guardian tabletop](context_guardian_legacy.md) - Stale Context Guardian tabletop values retained for audit history",
		"- [Context Guardian palette reference](context_guardian_palette.md) - Unrelated visual notes for a Context Guardian status page",
		"",
	].join("\n"),
	{ mode: 0o644 },
);

function writeMemory(filename, record) {
	const content = [
		"---",
		`name: ${record.name}`,
		`description: ${record.description}`,
		`type: ${record.type}`,
		`source: ${record.source}`,
		`created_at: ${record.createdAt}`,
		`updated_at: ${record.updatedAt}`,
		"---",
		"",
		record.body,
		"",
	].join("\n");
	writeFileSync(join(memoryDir, filename), content, { mode: 0o644 });
}
