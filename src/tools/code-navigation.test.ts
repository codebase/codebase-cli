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
	return positionAtIndex(source, index);
}

function positionIn(source: string, anchor: string, needle: string): { line: number; column: number } {
	const anchorIndex = source.indexOf(anchor);
	if (anchorIndex < 0) throw new Error(`missing ${anchor}`);
	const index = source.indexOf(needle, anchorIndex);
	if (index < 0) throw new Error(`missing ${needle} after ${anchor}`);
	return positionAtIndex(source, index);
}

function positionAtIndex(source: string, index: number): { line: number; column: number } {
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
			"export interface Greeter {",
			"  greet(name: string): string;",
			"}",
			"",
			"export function greet(name: string): string {",
			"  return name.toUpperCase();",
			"}",
			"",
			"export class ConsoleGreeter implements Greeter {",
			"  greet(name: string): string {",
			"    return greet(name);",
			"  }",
			"}",
			"",
			"export const greeter: Greeter = new ConsoleGreeter();",
			"export const version = 1;",
			"",
		].join("\n");
		mainSource = [
			'import { greet, greeter, type Greeter, version } from "./util";',
			"",
			"const active: Greeter = greeter;",
			"const message = greet(123);",
			'console.log(active.greet("Ada"), message, version);',
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

		expect(text(result)).toContain("src/util.ts:5:17 function greet");
		expect(result.details.results[0]).toMatchObject({ file: "src/util.ts", line: 5, column: 17 });
	});

	it("finds a TypeScript type definition at a position", async () => {
		const pos = positionOf(mainSource, "active.greet");

		const result = await run(ctx, { operation: "type_definition", path: "src/main.ts", ...pos });

		expect(text(result)).toContain("src/util.ts:1:18 interface Greeter");
	});

	it("finds project-local references", async () => {
		const pos = positionIn(utilSource, "export function greet", "greet");

		const result = await run(ctx, { operation: "references", path: "src/util.ts", ...pos });
		const out = text(result);

		expect(out).toContain("src/util.ts:5:17");
		expect(out).toContain("src/main.ts:1:10");
		expect(out).toContain("src/main.ts:4:17");
		expect(out).toContain("src/util.ts:11:12");
	});

	it("finds implementations of an interface member", async () => {
		const pos = positionOf(utilSource, "greet(name: string): string;");

		const result = await run(ctx, { operation: "implementation", path: "src/util.ts", ...pos });

		expect(text(result)).toContain("src/util.ts:10:3 method");
	});

	it("returns hover quick-info", async () => {
		const pos = positionOf(mainSource, "greet(123)");

		const result = await run(ctx, { operation: "hover", path: "src/main.ts", ...pos });

		expect(text(result)).toContain("greet(name: string): string");
	});

	it("outlines and filters symbols", async () => {
		const result = await run(ctx, { operation: "symbols", path: "src/util.ts", query: "ver" });

		expect(text(result)).toContain("src/util.ts:16:14 const version");
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
