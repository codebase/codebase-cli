import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createGrep } from "./grep.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createGrep>["execute"]>[1]) {
	return createGrep(ctx).execute("call", params);
}

describe("grep", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "grep-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds simple regex matches across files", async () => {
		writeFileSync(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");
		writeFileSync(join(dir, "b.ts"), "function foo() {}\n");

		const result = await run(ctx, { pattern: "foo" });
		expect(result.details.matches.length).toBeGreaterThanOrEqual(2);
		const files = result.details.matches.map((m) => m.file);
		expect(files).toContain("a.ts");
		expect(files).toContain("b.ts");
	});

	it("respects fixed_strings to disable regex", async () => {
		writeFileSync(join(dir, "f.txt"), "result.\nresult\nresults\n");

		// Without fixed_strings, "." matches anything; with it, requires literal dot
		const literal = await run(ctx, { pattern: "result.", fixed_strings: true });
		expect(literal.details.matches.length).toBe(1);
		expect(literal.details.matches[0].text).toBe("result.");
	});

	it("supports case_insensitive", async () => {
		writeFileSync(join(dir, "case.txt"), "FOO\nfoo\nBar\n");
		const result = await run(ctx, { pattern: "foo", case_insensitive: true });
		expect(result.details.matches.length).toBe(2);
	});

	it("filters by glob include pattern", async () => {
		writeFileSync(join(dir, "a.ts"), "needle\n");
		writeFileSync(join(dir, "a.md"), "needle\n");
		writeFileSync(join(dir, "a.txt"), "needle\n");

		const result = await run(ctx, { pattern: "needle", glob: "*.ts" });
		expect(result.details.matches.map((m) => m.file)).toEqual(["a.ts"]);
	});

	it("scopes to a sub path inside the project root", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub/a.ts"), "needle\n");
		writeFileSync(join(dir, "outer.ts"), "needle\n");

		const result = await run(ctx, { pattern: "needle", path: "sub" });
		expect(result.details.matches.map((m) => m.file)).toEqual(["sub/a.ts"]);
	});

	it("rejects paths outside the project root", async () => {
		await expect(run(ctx, { pattern: "x", path: "/etc" })).rejects.toThrow(/outside the project root/);
	});

	it("returns no matches with a friendly message", async () => {
		writeFileSync(join(dir, "x.txt"), "hello\n");
		const result = await run(ctx, { pattern: "wontfindme" });
		expect(result.details.matches).toEqual([]);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/No matches/);
	});

	it("caps results and reports truncation", async () => {
		const lines = Array.from({ length: 100 }, () => "needle").join("\n");
		writeFileSync(join(dir, "many.txt"), lines);

		const result = await run(ctx, { pattern: "needle", max_results: 10 });
		expect(result.details.matches.length).toBe(10);
		expect(result.details.truncated).toBe(true);
	});

	it("ignores standard build/VCS dirs by default", async () => {
		mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(dir, "node_modules/pkg/x.js"), "needle\n");
		writeFileSync(join(dir, "real.ts"), "needle\n");

		const result = await run(ctx, { pattern: "needle" });
		const files = result.details.matches.map((m) => m.file);
		expect(files).toContain("real.ts");
		expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
	});

	it("returns line and text in structured details", async () => {
		writeFileSync(join(dir, "lines.ts"), "first\nfind me\nthird\n");

		const result = await run(ctx, { pattern: "find me" });
		expect(result.details.matches[0]).toMatchObject({ file: "lines.ts", line: 2 });
		expect(result.details.matches[0].text).toBe("find me");
	});
});
