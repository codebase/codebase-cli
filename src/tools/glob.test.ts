import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createGlob } from "./glob.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createGlob>["execute"]>[1]) {
	return createGlob(ctx).execute("call", params);
}

describe("glob", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "glob-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("matches a simple double-star pattern", async () => {
		mkdirSync(join(dir, "src/agent"), { recursive: true });
		writeFileSync(join(dir, "src/agent/agent.ts"), "");
		writeFileSync(join(dir, "src/agent/agent.test.ts"), "");
		writeFileSync(join(dir, "package.json"), "{}");

		const result = await run(ctx, { pattern: "**/*.ts" });
		expect(result.details.matches.sort()).toEqual(["src/agent/agent.test.ts", "src/agent/agent.ts"]);
	});

	it("excludes node_modules and other build dirs by default", async () => {
		mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(dir, "node_modules/pkg/index.ts"), "");
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist/out.ts"), "");
		writeFileSync(join(dir, "src.ts"), "");

		const result = await run(ctx, { pattern: "**/*.ts" });
		expect(result.details.matches).toContain("src.ts");
		expect(result.details.matches.some((p) => p.includes("node_modules"))).toBe(false);
		expect(result.details.matches.some((p) => p.includes("dist"))).toBe(false);
	});

	it("honors .gitignore at the project root", async () => {
		writeFileSync(join(dir, ".gitignore"), "secrets.txt\nbuilt/\n");
		writeFileSync(join(dir, "secrets.txt"), "");
		writeFileSync(join(dir, "public.txt"), "");
		mkdirSync(join(dir, "built"));
		writeFileSync(join(dir, "built/output.txt"), "");

		const result = await run(ctx, { pattern: "**/*.txt" });
		expect(result.details.gitignoreApplied).toBe(true);
		expect(result.details.matches).toContain("public.txt");
		expect(result.details.matches).not.toContain("secrets.txt");
		expect(result.details.matches.every((p) => !p.startsWith("built/"))).toBe(true);
	});

	it("can disable .gitignore filtering", async () => {
		writeFileSync(join(dir, ".gitignore"), "*.secret\n");
		writeFileSync(join(dir, "creds.secret"), "");

		const result = await run(ctx, { pattern: "**/*.secret", respect_gitignore: false });
		expect(result.details.matches).toContain("creds.secret");
	});

	it("respects a path scope inside the project root", async () => {
		mkdirSync(join(dir, "src/a"), { recursive: true });
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "src/a/x.ts"), "");
		writeFileSync(join(dir, "scripts/y.ts"), "");

		const result = await run(ctx, { pattern: "**/*.ts", path: "scripts" });
		expect(result.details.matches).toEqual(["scripts/y.ts"]);
	});

	it("rejects paths outside the project root", async () => {
		await expect(run(ctx, { pattern: "*", path: "/etc" })).rejects.toThrow(/outside the project root/);
	});

	it("caps results and reports truncation", async () => {
		for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), "");
		const result = await run(ctx, { pattern: "*.txt", max_results: 10 });
		expect(result.details.matches.length).toBe(10);
		expect(result.details.truncated).toBe(true);
	});

	it("returns no matches with a friendly message", async () => {
		writeFileSync(join(dir, "x.ts"), "");
		const result = await run(ctx, { pattern: "**/*.nope" });
		expect(result.details.matches).toEqual([]);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/No matches/);
	});

	it("sorts results by mtime, newest first", async () => {
		writeFileSync(join(dir, "old.ts"), "");
		writeFileSync(join(dir, "new.ts"), "");
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(dir, "old.ts"), past, past);

		const result = await run(ctx, { pattern: "*.ts" });
		expect(result.details.matches[0]).toBe("new.ts");
		expect(result.details.matches[1]).toBe("old.ts");
	});
});
