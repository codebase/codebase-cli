import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createListFiles } from "./list-files.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createListFiles>["execute"]>[1]) {
	return createListFiles(ctx).execute("call", params);
}

describe("list_files", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "list-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists entries in the project root by default", async () => {
		writeFileSync(join(dir, "a.txt"), "");
		writeFileSync(join(dir, "b.md"), "");
		mkdirSync(join(dir, "src"));

		const result = await run(ctx, {});
		const paths = result.details.entries.map((e) => e.path).sort();
		expect(paths).toContain("a.txt");
		expect(paths).toContain("b.md");
		expect(paths).toContain("src/");
	});

	it("skips well-known build/VCS directories", async () => {
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules/lib.js"), "");
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git/HEAD"), "");
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist/bundle.js"), "");
		writeFileSync(join(dir, "keep.ts"), "");

		const result = await run(ctx, { recursive: true });
		const paths = result.details.entries.map((e) => e.path);
		expect(paths).toContain("keep.ts");
		expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
		expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
		expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
	});

	it("walks recursively when recursive is true", async () => {
		mkdirSync(join(dir, "deep/nested"), { recursive: true });
		writeFileSync(join(dir, "deep/nested/leaf.txt"), "x");

		const result = await run(ctx, { recursive: true });
		const paths = result.details.entries.map((e) => e.path);
		expect(paths).toContain("deep/nested/leaf.txt");
	});

	it("does not walk recursively by default", async () => {
		mkdirSync(join(dir, "a"));
		writeFileSync(join(dir, "a/inner.txt"), "x");

		const result = await run(ctx, {});
		const paths = result.details.entries.map((e) => e.path);
		expect(paths).toContain("a/");
		expect(paths).not.toContain("a/inner.txt");
	});

	it("caps results and reports truncation", async () => {
		for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), "");

		const result = await run(ctx, { max_results: 10 });
		expect(result.details.entries.length).toBe(10);
		expect(result.details.truncated).toBe(true);
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("capped at 10");
	});

	it("rejects paths outside the project root", async () => {
		await expect(run(ctx, { path: "/etc" })).rejects.toThrow(/outside the project root/);
	});

	it("reports a useful error when the directory does not exist", async () => {
		await expect(run(ctx, { path: "ghost" })).rejects.toThrow(/Cannot list ghost/);
	});

	it("returns file sizes in details", async () => {
		writeFileSync(join(dir, "small.txt"), "12345");
		const result = await run(ctx, {});
		const entry = result.details.entries.find((e) => e.path === "small.txt");
		expect(entry?.bytes).toBe(5);
	});
});
