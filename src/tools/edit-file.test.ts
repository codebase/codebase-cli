import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditFile } from "./edit-file.js";
import { FileStateCache } from "./file-state-cache.js";
import { createReadFile } from "./read-file.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function readThen(ctx: ToolContext, relPath: string, opts: { offset?: number; limit?: number } = {}) {
	const tool = createReadFile(ctx);
	await tool.execute("r", { path: relPath, ...opts });
}

async function edit(
	ctx: ToolContext,
	params: { path: string; old_string: string; new_string: string; replace_all?: boolean },
) {
	const tool = createEditFile(ctx);
	return tool.execute("e", params);
}

describe("edit_file", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("performs a single replacement when read first", async () => {
		const path = join(dir, "a.txt");
		writeFileSync(path, "hello world\nhello there\n");
		await readThen(ctx, "a.txt");

		const result = await edit(ctx, { path: "a.txt", old_string: "hello world", new_string: "hi world" });
		expect(result.details.replacements).toBe(1);
		expect(readFileSync(path, "utf8")).toBe("hi world\nhello there\n");
	});

	it("rejects edits to a file we never read", async () => {
		const path = join(dir, "b.txt");
		writeFileSync(path, "hello\n");

		await expect(edit(ctx, { path: "b.txt", old_string: "hello", new_string: "hi" })).rejects.toThrow(
			/not read in this turn/,
		);
	});

	it("rejects edits when the file changed on disk after read", async () => {
		const path = join(dir, "drift.txt");
		writeFileSync(path, "alpha\n");
		await readThen(ctx, "drift.txt");

		const stat = statSync(path);
		const future = new Date(stat.mtimeMs + 5000);
		utimesSync(path, future, future);

		await expect(edit(ctx, { path: "drift.txt", old_string: "alpha", new_string: "beta" })).rejects.toThrow(
			/changed on disk/,
		);
	});

	it("rejects edits to partial-view reads", async () => {
		const path = join(dir, "long.txt");
		writeFileSync(path, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
		await readThen(ctx, "long.txt", { offset: 1, limit: 10 });

		await expect(edit(ctx, { path: "long.txt", old_string: "line 1", new_string: "LINE 1" })).rejects.toThrow(
			/partially read/,
		);
	});

	it("reports ambiguous matches with the count", async () => {
		const path = join(dir, "ambig.txt");
		writeFileSync(path, "x\nx\nx\n");
		await readThen(ctx, "ambig.txt");

		await expect(edit(ctx, { path: "ambig.txt", old_string: "x", new_string: "y" })).rejects.toThrow(/3 times/);
	});

	it("reports no-match", async () => {
		const path = join(dir, "missing.txt");
		writeFileSync(path, "alpha\n");
		await readThen(ctx, "missing.txt");

		await expect(edit(ctx, { path: "missing.txt", old_string: "beta", new_string: "gamma" })).rejects.toThrow(
			/not found/,
		);
	});

	it("replaces every occurrence when replace_all is true", async () => {
		const path = join(dir, "all.txt");
		writeFileSync(path, "foo bar foo baz foo\n");
		await readThen(ctx, "all.txt");

		const result = await edit(ctx, {
			path: "all.txt",
			old_string: "foo",
			new_string: "qux",
			replace_all: true,
		});
		expect(result.details.replacements).toBe(3);
		expect(readFileSync(path, "utf8")).toBe("qux bar qux baz qux\n");
	});

	it("preserves a UTF-8 BOM through the edit", async () => {
		const path = join(dir, "bom.txt");
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		writeFileSync(path, Buffer.concat([bom, Buffer.from("hello\nworld\n", "utf8")]));
		await readThen(ctx, "bom.txt");

		await edit(ctx, { path: "bom.txt", old_string: "world", new_string: "everyone" });

		const after = readFileSync(path);
		expect(after.subarray(0, 3).equals(bom)).toBe(true);
		expect(after.subarray(3).toString("utf8")).toBe("hello\neveryone\n");
	});

	it("preserves CRLF line endings through the edit", async () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n");
		await readThen(ctx, "crlf.txt");

		await edit(ctx, { path: "crlf.txt", old_string: "beta", new_string: "BETA" });

		expect(readFileSync(path, "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\n");
	});

	it("preserves file mode after edit", async () => {
		const path = join(dir, "exec.sh");
		writeFileSync(path, "#!/bin/sh\necho hi\n");
		chmodSync(path, 0o755);
		await readThen(ctx, "exec.sh");

		await edit(ctx, { path: "exec.sh", old_string: "echo hi", new_string: "echo hello" });

		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o755);
	});

	it("rejects paths outside the project root", async () => {
		await expect(edit(ctx, { path: "/etc/passwd", old_string: "x", new_string: "y" })).rejects.toThrow(
			/outside the project root/,
		);
	});

	it("rejects identical old_string and new_string", async () => {
		const path = join(dir, "same.txt");
		writeFileSync(path, "hello\n");
		await readThen(ctx, "same.txt");

		await expect(edit(ctx, { path: "same.txt", old_string: "hello", new_string: "hello" })).rejects.toThrow(
			/identical/,
		);
	});

	it("rejects empty old_string with a hint about write_file", async () => {
		const path = join(dir, "empty.txt");
		writeFileSync(path, "x\n");
		await readThen(ctx, "empty.txt");

		await expect(edit(ctx, { path: "empty.txt", old_string: "", new_string: "y" })).rejects.toThrow(/non-empty/);
	});

	it("refreshes the snapshot so subsequent edits work without re-reading", async () => {
		const path = join(dir, "chain.txt");
		writeFileSync(path, "v1\n");
		await readThen(ctx, "chain.txt");

		await edit(ctx, { path: "chain.txt", old_string: "v1", new_string: "v2" });
		const result = await edit(ctx, { path: "chain.txt", old_string: "v2", new_string: "v3" });
		expect(result.details.replacements).toBe(1);
		expect(readFileSync(path, "utf8")).toBe("v3\n");
	});
});
