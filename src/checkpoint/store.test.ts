import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./store.js";

describe("CheckpointStore", () => {
	let cwd: string;
	let dataRoot: string;
	let store: CheckpointStore;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ckpt-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "ckpt-data-"));
		store = new CheckpointStore({ cwd, dataRoot });
	});
	afterEach(() => {
		store.dispose();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	function file(name: string): string {
		return join(cwd, name);
	}

	it("records pre-images and lists them chronologically", () => {
		writeFileSync(file("a.ts"), "v1");
		store.record("edit_file", file("a.ts"));
		store.record("write_file", file("b.ts")); // doesn't exist yet
		const entries = store.list();
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ seq: 1, display: "a.ts", existed: true, tool: "edit_file" });
		expect(entries[1]).toMatchObject({ seq: 2, display: "b.ts", existed: false });
	});

	it("firstSeqAtOrAfter finds the earliest entry at or after a timestamp", () => {
		writeFileSync(file("a.ts"), "v1");
		const seq1 = store.record("edit_file", file("a.ts")) as number;
		const t1 = store.list()[0].timestamp;
		writeFileSync(file("b.ts"), "v1");
		store.record("edit_file", file("b.ts"));
		// At-or-before the first edit → the first seq; after everything → undefined.
		expect(store.firstSeqAtOrAfter(t1)).toBe(seq1);
		expect(store.firstSeqAtOrAfter(0)).toBe(seq1);
		expect(store.firstSeqAtOrAfter(Number.MAX_SAFE_INTEGER)).toBeUndefined();
	});

	it("rewind restores an overwritten file's exact prior bytes", () => {
		writeFileSync(file("a.ts"), "original content");
		const seq = store.record("edit_file", file("a.ts"));
		writeFileSync(file("a.ts"), "mutated content");

		const result = store.rewindTo(seq as number);
		expect(result.restored.map((f) => f.display)).toEqual(["a.ts"]);
		expect(readFileSync(file("a.ts"), "utf8")).toBe("original content");
	});

	it("rewind deletes files that didn't exist before", () => {
		const seq = store.record("write_file", file("new.ts"));
		writeFileSync(file("new.ts"), "created by agent");

		const result = store.rewindTo(seq as number);
		expect(result.deleted.map((f) => f.display)).toEqual(["new.ts"]);
		expect(existsSync(file("new.ts"))).toBe(false);
	});

	it("rewind uses the OLDEST pre-image per path across the undone range", () => {
		writeFileSync(file("a.ts"), "v1");
		const first = store.record("edit_file", file("a.ts"));
		writeFileSync(file("a.ts"), "v2");
		store.record("edit_file", file("a.ts"));
		writeFileSync(file("a.ts"), "v3");

		store.rewindTo(first as number);
		expect(readFileSync(file("a.ts"), "utf8")).toBe("v1");
	});

	it("rewind to a mid-point keeps earlier entries intact", () => {
		writeFileSync(file("a.ts"), "v1");
		store.record("edit_file", file("a.ts")); // seq 1 — stays
		writeFileSync(file("a.ts"), "v2");
		const second = store.record("edit_file", file("a.ts")); // seq 2 — undone
		writeFileSync(file("a.ts"), "v3");

		store.rewindTo(second as number);
		expect(readFileSync(file("a.ts"), "utf8")).toBe("v2");
		expect(store.list().map((e) => e.seq)).toEqual([1]);
	});

	it("discard removes an entry whose mutation never landed", () => {
		writeFileSync(file("a.ts"), "v1");
		const seq = store.record("edit_file", file("a.ts"));
		store.discard(seq);
		expect(store.list()).toEqual([]);
	});

	it("round-trips binary-ish bytes exactly (BOM preserved)", () => {
		const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
		writeFileSync(file("bom.txt"), bom);
		const seq = store.record("write_file", file("bom.txt"));
		writeFileSync(file("bom.txt"), "replaced");

		store.rewindTo(seq as number);
		expect(readFileSync(file("bom.txt"))).toEqual(bom);
	});

	it("rewindTo an unknown seq is a no-op", () => {
		writeFileSync(file("a.ts"), "v1");
		store.record("edit_file", file("a.ts"));
		const result = store.rewindTo(99);
		expect(result.restored).toEqual([]);
		expect(store.list()).toHaveLength(1);
	});

	it("dispose removes the blob directory", () => {
		writeFileSync(file("a.ts"), "v1");
		store.record("edit_file", file("a.ts"));
		store.dispose();
		// rewind after dispose can't read blobs — file lands in skipped.
		const result = store.rewindTo(1);
		expect(result.skipped.map((f) => f.display)).toEqual(["a.ts"]);
	});
});
