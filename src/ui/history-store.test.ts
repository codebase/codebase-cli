import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryStore } from "./history-store.js";

describe("HistoryStore", () => {
	let dataRoot: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "hist-"));
	});
	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("returns empty list when no history file exists", () => {
		const store = new HistoryStore({ cwd: "/x/y", dataRoot });
		expect(store.load()).toEqual([]);
	});

	it("persists appended entries chronologically", () => {
		const store = new HistoryStore({ cwd: "/x/y", dataRoot });
		store.append("first");
		store.append("second");
		store.append("third");
		expect(store.load()).toEqual(["first", "second", "third"]);
	});

	it("collapses adjacent duplicates", () => {
		const store = new HistoryStore({ cwd: "/x/y", dataRoot });
		store.append("foo");
		store.append("foo");
		store.append("bar");
		store.append("foo");
		expect(store.load()).toEqual(["foo", "bar", "foo"]);
	});

	it("trims to max entries (oldest dropped)", () => {
		const store = new HistoryStore({ cwd: "/x/y", dataRoot, max: 3 });
		store.append("a");
		store.append("b");
		store.append("c");
		store.append("d");
		expect(store.load()).toEqual(["b", "c", "d"]);
	});

	it("ignores empty and whitespace entries", () => {
		const store = new HistoryStore({ cwd: "/x/y", dataRoot });
		store.append("real");
		store.append("");
		store.append("   ");
		expect(store.load()).toEqual(["real"]);
	});

	it("isolates per-cwd", () => {
		const a = new HistoryStore({ cwd: "/proj/a", dataRoot });
		const b = new HistoryStore({ cwd: "/proj/b", dataRoot });
		a.append("alpha");
		b.append("beta");
		expect(a.load()).toEqual(["alpha"]);
		expect(b.load()).toEqual(["beta"]);
	});
});
