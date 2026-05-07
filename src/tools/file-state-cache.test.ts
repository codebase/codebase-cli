import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileSnapshot, FileStateCache } from "./file-state-cache.js";

function makeSnapshot(overrides: Partial<FileSnapshot> & Pick<FileSnapshot, "path" | "content">): FileSnapshot {
	return {
		mtimeMs: 0,
		size: Buffer.byteLength(overrides.content, "utf8"),
		hasBOM: false,
		eol: "\n",
		isPartialView: false,
		storedAt: Date.now(),
		...overrides,
	};
}

describe("FileStateCache", () => {
	let dir: string;
	let cache: FileStateCache;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fsc-"));
		cache = new FileStateCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns missing for unread paths", () => {
		expect(cache.check(join(dir, "absent.txt"))).toBe("missing");
		expect(cache.get(join(dir, "absent.txt"))).toBeUndefined();
	});

	it("returns fresh when stat matches", () => {
		const path = join(dir, "fresh.txt");
		writeFileSync(path, "hello");
		const stat = statSync(path);
		cache.record(makeSnapshot({ path, content: "hello", mtimeMs: stat.mtimeMs, size: stat.size }));

		expect(cache.check(path)).toBe("fresh");
	});

	it("returns modified when mtime drifts", () => {
		const path = join(dir, "drifted.txt");
		writeFileSync(path, "hello");
		const stat = statSync(path);
		cache.record(makeSnapshot({ path, content: "hello", mtimeMs: stat.mtimeMs, size: stat.size }));

		const future = new Date(stat.mtimeMs + 5000);
		utimesSync(path, future, future);

		expect(cache.check(path)).toBe("modified");
	});

	it("returns modified when the file is deleted", () => {
		const path = join(dir, "vanished.txt");
		writeFileSync(path, "hello");
		const stat = statSync(path);
		cache.record(makeSnapshot({ path, content: "hello", mtimeMs: stat.mtimeMs, size: stat.size }));

		rmSync(path);
		expect(cache.check(path)).toBe("modified");
	});

	it("normalizes relative and absolute paths to the same key", () => {
		const path = join(dir, "norm.txt");
		writeFileSync(path, "hi");
		const stat = statSync(path);
		cache.record(makeSnapshot({ path, content: "hi", mtimeMs: stat.mtimeMs, size: stat.size }));

		expect(cache.get(path)?.content).toBe("hi");
		// Absolute path resolution should still find it.
		expect(cache.check(path)).toBe("fresh");
	});

	it("invalidate removes the snapshot", () => {
		const path = join(dir, "drop.txt");
		cache.record(makeSnapshot({ path, content: "x" }));
		cache.invalidate(path);
		expect(cache.size()).toBe(0);
		expect(cache.check(path)).toBe("missing");
	});

	it("evicts the oldest entry when over maxEntries", () => {
		const small = new FileStateCache({ maxEntries: 2 });
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		const c = join(dir, "c.txt");
		small.record(makeSnapshot({ path: a, content: "a" }));
		small.record(makeSnapshot({ path: b, content: "b" }));
		small.record(makeSnapshot({ path: c, content: "c" }));
		expect(small.size()).toBe(2);
		expect(small.get(a)).toBeUndefined();
		expect(small.get(b)?.content).toBe("b");
		expect(small.get(c)?.content).toBe("c");
	});

	it("evicts when over the byte budget", () => {
		const tight = new FileStateCache({ byteBudget: 10 });
		tight.record(makeSnapshot({ path: join(dir, "small.txt"), content: "12345" }));
		tight.record(makeSnapshot({ path: join(dir, "big.txt"), content: "123456789012345" }));
		expect(tight.size()).toBeLessThanOrEqual(1);
	});

	it("get refreshes LRU position", () => {
		const small = new FileStateCache({ maxEntries: 2 });
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		const c = join(dir, "c.txt");
		small.record(makeSnapshot({ path: a, content: "a" }));
		small.record(makeSnapshot({ path: b, content: "b" }));
		// Refresh A so B becomes oldest.
		small.get(a);
		small.record(makeSnapshot({ path: c, content: "c" }));
		expect(small.get(a)?.content).toBe("a");
		expect(small.get(b)).toBeUndefined();
	});

	it("preserves partial-view metadata", () => {
		const path = join(dir, "partial.txt");
		cache.record(
			makeSnapshot({
				path,
				content: "first 5 lines",
				isPartialView: true,
				range: { startLine: 1, endLine: 5 },
			}),
		);
		const snap = cache.get(path);
		expect(snap?.isPartialView).toBe(true);
		expect(snap?.range).toEqual({ startLine: 1, endLine: 5 });
	});
});
