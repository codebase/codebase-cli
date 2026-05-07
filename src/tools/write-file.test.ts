import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createReadFile } from "./read-file.js";
import type { ToolContext } from "./types.js";
import { createWriteFile } from "./write-file.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function readThen(ctx: ToolContext, relPath: string) {
	await createReadFile(ctx).execute("r", { path: relPath });
}

async function write(ctx: ToolContext, params: { path: string; content: string }) {
	return createWriteFile(ctx).execute("w", params);
}

describe("write_file", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "write-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates a new file at the project root", async () => {
		const result = await write(ctx, { path: "new.txt", content: "hello\n" });
		expect(result.details.created).toBe(true);
		expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("hello\n");
	});

	it("creates parent directories on demand", async () => {
		await write(ctx, { path: "deep/nested/path/file.txt", content: "x\n" });
		expect(existsSync(join(dir, "deep/nested/path/file.txt"))).toBe(true);
	});

	it("rejects overwrites of files that were not read first", async () => {
		const path = join(dir, "exists.txt");
		writeFileSync(path, "old\n");

		await expect(write(ctx, { path: "exists.txt", content: "new\n" })).rejects.toThrow(/not read in this turn/);
		expect(readFileSync(path, "utf8")).toBe("old\n");
	});

	it("rejects overwrites when the on-disk file changed since read", async () => {
		const path = join(dir, "drift.txt");
		writeFileSync(path, "v1\n");
		await readThen(ctx, "drift.txt");

		const stat = statSync(path);
		const future = new Date(stat.mtimeMs + 5000);
		utimesSync(path, future, future);

		await expect(write(ctx, { path: "drift.txt", content: "v2\n" })).rejects.toThrow(/changed on disk/);
		expect(readFileSync(path, "utf8")).toBe("v1\n");
	});

	it("overwrites cleanly when the file was read in this turn", async () => {
		const path = join(dir, "ok.txt");
		writeFileSync(path, "before\n");
		await readThen(ctx, "ok.txt");

		const result = await write(ctx, { path: "ok.txt", content: "after\n" });
		expect(result.details.created).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("after\n");
	});

	it("preserves a UTF-8 BOM when overwriting a BOM file", async () => {
		const path = join(dir, "bom.txt");
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		writeFileSync(path, Buffer.concat([bom, Buffer.from("old\n", "utf8")]));
		await readThen(ctx, "bom.txt");

		await write(ctx, { path: "bom.txt", content: "fresh content\n" });

		const after = readFileSync(path);
		expect(after.subarray(0, 3).equals(bom)).toBe(true);
		expect(after.subarray(3).toString("utf8")).toBe("fresh content\n");
	});

	it("preserves CRLF line endings when overwriting", async () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "a\r\nb\r\n");
		await readThen(ctx, "crlf.txt");

		await write(ctx, { path: "crlf.txt", content: "x\ny\nz\n" });
		expect(readFileSync(path, "utf8")).toBe("x\r\ny\r\nz\r\n");
	});

	it("preserves file mode when overwriting", async () => {
		const path = join(dir, "exec.sh");
		writeFileSync(path, "#!/bin/sh\n");
		chmodSync(path, 0o755);
		await readThen(ctx, "exec.sh");

		await write(ctx, { path: "exec.sh", content: "#!/bin/sh\necho hi\n" });
		expect(statSync(path).mode & 0o777).toBe(0o755);
	});

	it("rejects paths outside the project root", async () => {
		await expect(write(ctx, { path: "/etc/passwd", content: "x" })).rejects.toThrow(/outside the project root/);
	});

	it("records a snapshot so subsequent edits work without re-reading", async () => {
		await write(ctx, { path: "chain.txt", content: "first\n" });

		const snap = ctx.fileStateCache.get(join(dir, "chain.txt"));
		expect(snap?.content).toBe("first\n");
		expect(snap?.isPartialView).toBe(false);
	});

	it("creates an empty file when content is empty", async () => {
		const result = await write(ctx, { path: "empty.txt", content: "" });
		expect(result.details.bytes).toBe(0);
		expect(readFileSync(join(dir, "empty.txt"), "utf8")).toBe("");
	});
});
