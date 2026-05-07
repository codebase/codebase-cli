import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createReadFile } from "./read-file.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createReadFile>["execute"]>[1]) {
	const tool = createReadFile(ctx);
	return tool.execute("call-1", params);
}

describe("read_file", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "read-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a small text file with line numbers and records a snapshot", async () => {
		const path = join(dir, "hello.txt");
		writeFileSync(path, "first line\nsecond line\n");

		const result = await run(ctx, { path: "hello.txt" });
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(text).toContain("     1\tfirst line");
		expect(text).toContain("     2\tsecond line");
		expect(result.details.totalLines).toBe(2);
		expect(result.details.isPartialView).toBe(false);

		const snap = ctx.fileStateCache.get(path);
		expect(snap?.content).toBe("first line\nsecond line\n");
	});

	it("strips and remembers a UTF-8 BOM", async () => {
		const path = join(dir, "bom.txt");
		writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\nworld\n", "utf8")]));

		const result = await run(ctx, { path: "bom.txt" });
		expect(result.details.hasBOM).toBe(true);

		const snap = ctx.fileStateCache.get(path);
		expect(snap?.hasBOM).toBe(true);
		expect(snap?.content.startsWith("﻿")).toBe(false);
		expect(snap?.content).toBe("hello\nworld\n");
	});

	it("detects CRLF line endings", async () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "a\r\nb\r\nc\r\n");

		const result = await run(ctx, { path: "crlf.txt" });
		expect(result.details.eol).toBe("\r\n");
		expect(ctx.fileStateCache.get(path)?.eol).toBe("\r\n");
	});

	it("returns a partial view when offset/limit is supplied", async () => {
		const path = join(dir, "long.txt");
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		writeFileSync(path, lines.join("\n"));

		const result = await run(ctx, { path: "long.txt", offset: 10, limit: 5 });
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(text).toContain("    10\tline 10");
		expect(text).toContain("    14\tline 14");
		expect(text).not.toContain("line 15");
		expect(text).toContain("showing lines 10-14 of 50");

		const snap = ctx.fileStateCache.get(path);
		expect(snap?.isPartialView).toBe(true);
		expect(snap?.range).toEqual({ startLine: 10, endLine: 14 });
	});

	it("returns an image as base64 ImageContent", async () => {
		const path = join(dir, "pixel.png");
		// Smallest valid PNG (1x1 transparent)
		const png = Buffer.from(
			"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
				"0d0a2db40000000049454e44ae426082",
			"hex",
		);
		writeFileSync(path, png);

		const result = await run(ctx, { path: "pixel.png" });
		expect(result.details.isImage).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("rejects directories with a hint", async () => {
		await expect(run(ctx, { path: "." })).rejects.toThrow(/directory/);
	});

	it("rejects files outside the project root", async () => {
		await expect(run(ctx, { path: "/etc/passwd" })).rejects.toThrow(/outside the project root/);
	});

	it("rejects binary files (null-byte heuristic)", async () => {
		const path = join(dir, "binary.dat");
		writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
		await expect(run(ctx, { path: "binary.dat" })).rejects.toThrow(/binary/i);
	});

	it("rejects files larger than 5 MB", async () => {
		const path = join(dir, "huge.txt");
		writeFileSync(path, "a".repeat(6 * 1024 * 1024));
		await expect(run(ctx, { path: "huge.txt" })).rejects.toThrow(/limit/);
	});

	it("rejects missing files with a useful message", async () => {
		await expect(run(ctx, { path: "ghost.txt" })).rejects.toThrow(/Cannot read ghost.txt/);
	});
});
