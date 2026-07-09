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
const staleUpdatedAt = "2026-01-01T00:00:00.000Z";

writeMemory("nimbus_billing_deploy.md", {
	name: "Nimbus billing deploy runbook",
	description: "Nimbus billing deploy runbook for release handoffs",
	type: "project",
	source: "bench seed: release-ops fixture",
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: freshUpdatedAt,
	body: [
		"Release codename: cobalt-sparrow",
		"Staging flag: NIMBUS_BILLING_V2=true",
		"Owner: Mira Chen",
		"Verification command: npm run test:billing && npm run smoke:nimbus",
		"Deploy note: capture the staging preview URL before handoff.",
	].join("\n"),
});

writeMemory("nimbus_billing_legacy.md", {
	name: "Legacy Nimbus billing deploy note",
	description: "Old Nimbus billing deploy runbook retained for audit history",
	type: "project",
	source: "bench seed: stale legacy fixture",
	createdAt: "2025-12-15T00:00:00.000Z",
	updatedAt: staleUpdatedAt,
	body: [
		"Release codename: amber-river",
		"Staging flag: NIMBUS_BILLING_V1=true",
		"Owner: Marin Patel",
		"Verification command: npm run test:legacy-billing",
		"Legacy note: do not use for current deploys.",
	].join("\n"),
});

writeMemory("brand_palette.md", {
	name: "Brand palette reference",
	description: "Palette guidance for marketing pages",
	type: "reference",
	source: "bench seed: unrelated fixture",
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: freshUpdatedAt,
	body: [
		"Primary brand color: ops-blue",
		"Accent color: warm silver",
		"This memory is unrelated to deployment plans.",
	].join("\n"),
});

writeFileSync(
	join(memoryDir, "MEMORY.md"),
	[
		"- [Nimbus billing deploy runbook](nimbus_billing_deploy.md) - Nimbus billing deploy runbook for release handoffs",
		"- [Legacy Nimbus billing deploy note](nimbus_billing_legacy.md) - Old Nimbus billing deploy runbook retained for audit history",
		"- [Brand palette reference](brand_palette.md) - Palette guidance for marketing pages",
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
