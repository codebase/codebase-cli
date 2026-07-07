import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMockToolContext } from "./__test__/mock-tool-context.js";
import { createCodeNavigation } from "./code-navigation.js";
import type { ToolContext } from "./types.js";

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createCodeNavigation>["execute"]>[1]) {
	return createCodeNavigation(ctx).execute("call-1", params);
}

function text(result: Awaited<ReturnType<typeof run>>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function positionOf(source: string, needle: string): { line: number; column: number } {
	const index = source.indexOf(needle);
	if (index < 0) throw new Error(`missing ${needle}`);
	const before = source.slice(0, index);
	const lines = before.split("\n");
	return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

describe("code_navigation", () => {
	let dir: string;
	let ctx: ToolContext;
	let mainSource: string;
	let utilSource: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "code-nav-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "Node16",
					moduleResolution: "Node16",
					strict: true,
				},
				include: ["src/**/*.ts"],
			}),
		);
		utilSource = [
			"export function greet(name: string): string {",
			"  return name.toUpperCase();",
			"}",
			"",
			"export const version = 1;",
			"",
		].join("\n");
		mainSource = [
			'import { greet, version } from "./util";',
			"",
			"const message = greet(123);",
			"console.log(message, version);",
			"",
		].join("\n");
		writeFileSync(join(dir, "src", "util.ts"), utilSource);
		writeFileSync(join(dir, "src", "main.ts"), mainSource);
		ctx = makeMockToolContext(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds a definition at a TypeScript position", async () => {
		const pos = positionOf(mainSource, "greet(123)");

		const result = await run(ctx, { operation: "definition", path: "src/main.ts", ...pos });

		expect(text(result)).toContain("src/util.ts:1:17 function greet");
		expect(result.details.results[0]).toMatchObject({ file: "src/util.ts", line: 1, column: 17 });
	});

	it("finds project-local references", async () => {
		const pos = positionOf(utilSource, "greet(name");

		const result = await run(ctx, { operation: "references", path: "src/util.ts", ...pos });
		const out = text(result);

		expect(out).toContain("src/util.ts:1:17");
		expect(out).toContain("src/main.ts:1:10");
		expect(out).toContain("src/main.ts:3:17");
	});

	it("returns hover quick-info", async () => {
		const pos = positionOf(mainSource, "greet(123)");

		const result = await run(ctx, { operation: "hover", path: "src/main.ts", ...pos });

		expect(text(result)).toContain("greet(name: string): string");
	});

	it("outlines and filters symbols", async () => {
		const result = await run(ctx, { operation: "symbols", path: "src/util.ts", query: "ver" });

		expect(text(result)).toContain("src/util.ts:5:14 const version");
		expect(text(result)).not.toContain("greet");
	});

	it("returns TypeScript diagnostics for a file", async () => {
		const result = await run(ctx, { operation: "diagnostics", path: "src/main.ts" });

		expect(text(result)).toContain("TS2345");
		expect(text(result)).toContain("Argument of type 'number'");
	});

	it("rejects paths outside the project root", async () => {
		await expect(run(ctx, { operation: "symbols", path: "/etc/passwd" })).rejects.toThrow(/outside/);
	});
});
