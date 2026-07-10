import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMemoryIndex } from "../../memory/index-file.js";
import { MemoryStore } from "../../memory/store.js";
import type { CommandContext } from "../types.js";
import { memory } from "./memory.js";

describe("/memory", () => {
	let cwd: string;
	let dataRoot: string;
	let store: MemoryStore;
	let emits: string[];
	let ctx: CommandContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "memory-cmd-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "memory-cmd-data-"));
		store = new MemoryStore({ cwd, dataRoot, sourceSessionId: "s-test" });
		emits = [];
		ctx = {
			bundle: { memory: store } as CommandContext["bundle"],
			state: {} as CommandContext["state"],
			emit: (text: string) => emits.push(text),
			clearDisplay: () => {},
			exit: () => {},
			registry: {} as CommandContext["registry"],
			switchModel: async () => {},
			openModelPicker: () => {},
			switchSession: async () => {},
		};
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	function seed(): void {
		store.save({
			filename: "deploy.md",
			name: "Deploy runbook",
			description: "Release deploy steps",
			type: "project",
			body: "Run npm test.",
			now: Date.UTC(2026, 6, 7),
		});
		store.markUsed("deploy.md", { now: Date.UTC(2026, 6, 8) });
		rebuildMemoryIndex(store);
	}

	it("shows the index by default", () => {
		seed();

		memory.handler("", ctx);

		expect(emits).toEqual([expect.stringContaining("[Deploy runbook](deploy.md)")]);
	});

	it("lists memories with provenance", () => {
		seed();

		memory.handler("list", ctx);

		expect(emits[0]).toContain("deploy.md [project] Deploy runbook");
		expect(emits[0]).toContain("source: local project memory");
		expect(emits[0]).toContain("session: s-test");
		expect(emits[0]).toContain("last used: 2026-07-08");
		expect(emits[0]).toContain("retrievals: 1");
	});

	it("shows one memory body with provenance", () => {
		seed();

		memory.handler("show deploy.md", ctx);

		expect(emits[0]).toContain("# Deploy runbook (project)");
		expect(emits[0]).toContain("source session: s-test");
		expect(emits[0]).toContain("Run npm test.");
	});

	it("forgets a memory and rebuilds the index", () => {
		seed();

		memory.handler("forget deploy.md", ctx);

		expect(emits).toEqual(["forgot memory: deploy.md"]);
		expect(store.read("deploy.md")).toBeNull();
		expect(store.index()).toBe("");
	});
});
