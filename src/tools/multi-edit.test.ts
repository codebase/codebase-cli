import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createMultiEdit } from "./multi-edit.js";
import { createReadFile } from "./read-file.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function readThen(ctx: ToolContext, relPath: string) {
	await createReadFile(ctx).execute("r", { path: relPath });
}

async function multi(
	ctx: ToolContext,
	params: { path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] },
) {
	return createMultiEdit(ctx).execute("m", params);
}

describe("multi_edit", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "multi-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("applies multiple edits in order to a single file", async () => {
		const path = join(dir, "rename.ts");
		writeFileSync(path, "const oldName = 1;\nfunction oldName() {}\n");
		await readThen(ctx, "rename.ts");

		const result = await multi(ctx, {
			path: "rename.ts",
			edits: [
				{ old_string: "const oldName", new_string: "const newName" },
				{ old_string: "function oldName", new_string: "function newName" },
			],
		});

		expect(result.details.edits).toBe(2);
		expect(result.details.replacements).toBe(2);
		expect(readFileSync(path, "utf8")).toBe("const newName = 1;\nfunction newName() {}\n");
	});

	it("each edit sees the result of previous edits", async () => {
		const path = join(dir, "chain.txt");
		writeFileSync(path, "v1\n");
		await readThen(ctx, "chain.txt");

		await multi(ctx, {
			path: "chain.txt",
			edits: [
				{ old_string: "v1", new_string: "v2" },
				{ old_string: "v2", new_string: "v3" },
				{ old_string: "v3", new_string: "v4" },
			],
		});

		expect(readFileSync(path, "utf8")).toBe("v4\n");
	});

	it("aborts the entire batch if any edit fails (no partial write)", async () => {
		const path = join(dir, "atomic.txt");
		writeFileSync(path, "alpha\nbeta\n");
		await readThen(ctx, "atomic.txt");

		await expect(
			multi(ctx, {
				path: "atomic.txt",
				edits: [
					{ old_string: "alpha", new_string: "ALPHA" },
					{ old_string: "missing-text", new_string: "anything" },
				],
			}),
		).rejects.toThrow(/edit #2 failed/);

		// File on disk is unchanged.
		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n");
	});

	it("supports replace_all per edit", async () => {
		const path = join(dir, "all.txt");
		writeFileSync(path, "a a a b b\n");
		await readThen(ctx, "all.txt");

		const result = await multi(ctx, {
			path: "all.txt",
			edits: [
				{ old_string: "a", new_string: "A", replace_all: true },
				{ old_string: "b", new_string: "B", replace_all: true },
			],
		});

		expect(result.details.replacements).toBe(5);
		expect(readFileSync(path, "utf8")).toBe("A A A B B\n");
	});

	it("rejects without a prior read", async () => {
		const path = join(dir, "noread.txt");
		writeFileSync(path, "x\n");

		await expect(multi(ctx, { path: "noread.txt", edits: [{ old_string: "x", new_string: "y" }] })).rejects.toThrow(
			/not read in this turn/,
		);
	});

	it("rejects when file changed on disk after read", async () => {
		const path = join(dir, "drift.txt");
		writeFileSync(path, "alpha\n");
		await readThen(ctx, "drift.txt");

		const stat = statSync(path);
		const future = new Date(stat.mtimeMs + 5000);
		utimesSync(path, future, future);

		await expect(
			multi(ctx, { path: "drift.txt", edits: [{ old_string: "alpha", new_string: "beta" }] }),
		).rejects.toThrow(/changed on disk/);
	});

	it("preserves BOM through a multi-edit batch", async () => {
		const path = join(dir, "bom.txt");
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		writeFileSync(path, Buffer.concat([bom, Buffer.from("one two three\n", "utf8")]));
		await readThen(ctx, "bom.txt");

		await multi(ctx, {
			path: "bom.txt",
			edits: [
				{ old_string: "one", new_string: "ONE" },
				{ old_string: "three", new_string: "THREE" },
			],
		});

		const after = readFileSync(path);
		expect(after.subarray(0, 3).equals(bom)).toBe(true);
		expect(after.subarray(3).toString("utf8")).toBe("ONE two THREE\n");
	});

	it("preserves CRLF line endings through a multi-edit batch", async () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n");
		await readThen(ctx, "crlf.txt");

		await multi(ctx, {
			path: "crlf.txt",
			edits: [
				{ old_string: "alpha", new_string: "ALPHA" },
				{ old_string: "gamma", new_string: "GAMMA" },
			],
		});

		expect(readFileSync(path, "utf8")).toBe("ALPHA\r\nbeta\r\nGAMMA\r\n");
	});

	it("reports the failing edit's index and reason", async () => {
		const path = join(dir, "report.txt");
		writeFileSync(path, "x\nx\n");
		await readThen(ctx, "report.txt");

		await expect(
			multi(ctx, {
				path: "report.txt",
				edits: [
					{ old_string: "x", new_string: "y" }, // ambiguous: "x" appears twice
				],
			}),
		).rejects.toThrow(/edit #1 failed.*2 times/);
	});

	it("refreshes the snapshot so a subsequent edit_file works without re-reading", async () => {
		const path = join(dir, "subseq.txt");
		writeFileSync(path, "hello world\n");
		await readThen(ctx, "subseq.txt");

		await multi(ctx, {
			path: "subseq.txt",
			edits: [{ old_string: "hello", new_string: "hi" }],
		});

		// Cache should now reflect the latest disk state.
		const snap = ctx.fileStateCache.get(path);
		expect(snap?.content).toBe("hi world\n");
		expect(snap?.isPartialView).toBe(false);
	});
});
