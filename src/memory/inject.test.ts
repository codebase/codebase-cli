import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryAddendum, buildRelevantMemoryReminder } from "./inject.js";
import { MemoryStore } from "./store.js";

describe("memory injection", () => {
	let dataRoot: string;
	let cwd: string;
	let store: MemoryStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "mem-inject-data-"));
		cwd = mkdtempSync(join(tmpdir(), "mem-inject-cwd-"));
		store = new MemoryStore({ cwd, dataRoot });
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("builds the original MEMORY.md system addendum from the index", () => {
		expect(buildMemoryAddendum(store)).toBe("");

		store.writeIndex("- [Deploy](deploy.md) — Release checklist");

		expect(buildMemoryAddendum(store)).toContain("# Project memory");
		expect(buildMemoryAddendum(store)).toContain("Release checklist");
	});

	it("injects only relevant full memory bodies with provenance", () => {
		store.save({
			filename: "deploy.md",
			name: "Deploy checklist",
			description: "Release deploy validation",
			type: "project",
			body: "Run npm run check before deploy and record the build URL.",
		});
		store.save({
			filename: "colors.md",
			name: "Brand colors",
			description: "Visual design reference",
			type: "reference",
			body: "Primary green is #21a67a.",
		});

		const reminder = buildRelevantMemoryReminder(store, "Please handle the deploy validation.", {
			now: Date.UTC(2026, 6, 7),
		});

		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("Deploy checklist");
		expect(reminder).toContain("file: deploy.md; type: project; source: local project memory");
		expect(reminder).toContain("created:");
		expect(reminder).toContain("updated:");
		expect(reminder).toContain("last_used: never");
		expect(reminder).toContain("retrievals: 0");
		expect(reminder).toContain("stale: no");
		expect(reminder).toContain("Run npm run check before deploy");
		expect(reminder).not.toContain("Brand colors");
	});

	it("can record prompt-time retrieval provenance", () => {
		store.save({
			filename: "deploy.md",
			name: "Deploy checklist",
			description: "Release deploy validation",
			type: "project",
			body: "Run npm run check before deploy and record the build URL.",
			now: Date.UTC(2026, 6, 7),
		});

		const reminder = buildRelevantMemoryReminder(store, "Please handle the deploy validation.", {
			now: Date.UTC(2026, 6, 8),
			recordUsage: true,
		});

		expect(reminder).toContain("last_used: 2026-07-08");
		expect(reminder).toContain("retrievals: 1");
		expect(store.read("deploy.md")).toMatchObject({
			lastUsedAt: Date.UTC(2026, 6, 8),
			retrievalCount: 1,
			updatedAt: Date.UTC(2026, 6, 7),
		});
	});

	it("marks older matching memories stale", () => {
		const oldDate = Date.UTC(2026, 4, 15);
		store.save({
			filename: "old_deploy.md",
			name: "Old deploy note",
			description: "Deploy workaround",
			type: "feedback",
			body: "The old staging deploy needs a manual cache clear.",
			now: oldDate,
		});

		const reminder = buildRelevantMemoryReminder(store, "Use the deploy workaround.", {
			now: Date.UTC(2026, 6, 7),
		});

		expect(reminder).toContain("Old deploy note");
		expect(reminder).toContain("stale: yes");
	});

	it("returns empty text when the prompt does not match any memory", () => {
		store.save({
			filename: "deploy.md",
			name: "Deploy checklist",
			description: "Release deploy validation",
			type: "project",
			body: "Run npm run check before deploy.",
		});

		expect(buildRelevantMemoryReminder(store, "What should we name the new palette?")).toBe("");
	});
});
