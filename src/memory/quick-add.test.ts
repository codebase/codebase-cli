import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quickAddMemory } from "./quick-add.js";
import { MemoryStore } from "./store.js";

describe("quickAddMemory", () => {
	let cwd: string;
	let store: MemoryStore;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "quickmem-"));
		store = new MemoryStore({ cwd });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("saves a user memory from a bare # line", () => {
		const rec = quickAddMemory(store, "# always run the linter before committing");
		expect(rec.type).toBe("user");
		expect(rec.body).toBe("always run the linter before committing");
		expect(store.list()).toHaveLength(1);
	});

	it("honors a #<type>: prefix", () => {
		const rec = quickAddMemory(store, "#feedback: prefer small focused commits");
		expect(rec.type).toBe("feedback");
		expect(rec.body).toBe("prefer small focused commits");
	});

	it("derives a kebab slug filename and a clipped name", () => {
		const long = `# ${"word ".repeat(30)}`;
		const rec = quickAddMemory(store, long);
		expect(rec.filename).toMatch(/\.md$/);
		expect(rec.name.endsWith("…")).toBe(true);
	});

	it("two quick-adds don't collide on filename", () => {
		quickAddMemory(store, "# note one");
		quickAddMemory(store, "# note two");
		expect(store.list()).toHaveLength(2);
	});
});
