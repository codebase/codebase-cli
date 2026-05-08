import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsEngine, formatDiagnostics } from "./engine.js";
import type { Diagnostic, LanguageChecker } from "./types.js";

function fakeChecker(opts: {
	name: string;
	extensions: string[];
	detect: boolean;
	diagnostics: Diagnostic[];
}): LanguageChecker {
	return {
		name: opts.name,
		extensions: opts.extensions,
		detect: vi.fn(async () => opts.detect),
		run: vi.fn(async () => opts.diagnostics),
	};
}

describe("DiagnosticsEngine", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "diag-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns no diagnostics for an empty file list", async () => {
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [] });
		expect(await engine.forFiles([])).toEqual([]);
	});

	it("only runs checkers whose extension matches", async () => {
		const tsChecker = fakeChecker({
			name: "ts",
			extensions: [".ts"],
			detect: true,
			diagnostics: [{ file: "a.ts", line: 1, severity: "error", message: "ts err", source: "ts" }],
		});
		const goChecker = fakeChecker({
			name: "go",
			extensions: [".go"],
			detect: true,
			diagnostics: [{ file: "a.go", line: 1, severity: "error", message: "go err", source: "go" }],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [tsChecker, goChecker] });
		const diags = await engine.forFiles(["src/a.ts"]);
		expect(diags).toHaveLength(1);
		expect(diags[0].source).toBe("ts");
		expect(goChecker.run).not.toHaveBeenCalled();
	});

	it("skips checkers whose detect returns false", async () => {
		const checker = fakeChecker({
			name: "ts",
			extensions: [".ts"],
			detect: false,
			diagnostics: [{ file: "a.ts", line: 1, severity: "error", message: "x", source: "ts" }],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [checker] });
		expect(await engine.forFiles(["a.ts"])).toEqual([]);
		expect(checker.run).not.toHaveBeenCalled();
	});

	it("caches detect results per checker", async () => {
		const checker = fakeChecker({
			name: "ts",
			extensions: [".ts"],
			detect: true,
			diagnostics: [],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [checker] });
		await engine.forFiles(["a.ts"]);
		await engine.forFiles(["b.ts"]);
		await engine.forFiles(["c.ts"]);
		expect(checker.detect).toHaveBeenCalledTimes(1);
	});

	it("runs multiple matching checkers in parallel and concatenates results", async () => {
		const tsc = fakeChecker({
			name: "tsc",
			extensions: [".ts"],
			detect: true,
			diagnostics: [{ file: "a.ts", line: 1, severity: "error", message: "tsc err", source: "tsc" }],
		});
		const eslint = fakeChecker({
			name: "eslint",
			extensions: [".ts"],
			detect: true,
			diagnostics: [{ file: "a.ts", line: 5, severity: "warning", message: "eslint warn", source: "eslint" }],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [tsc, eslint] });
		const diags = await engine.forFiles(["a.ts"]);
		expect(diags.map((d) => d.source).sort()).toEqual(["eslint", "tsc"]);
	});

	it("swallows checker exceptions so one bad checker doesn't kill the batch", async () => {
		const broken: LanguageChecker = {
			name: "broken",
			extensions: [".ts"],
			detect: async () => true,
			run: async () => {
				throw new Error("boom");
			},
		};
		const ok = fakeChecker({
			name: "ok",
			extensions: [".ts"],
			detect: true,
			diagnostics: [{ file: "a.ts", line: 1, severity: "error", message: "fine", source: "ok" }],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [broken, ok] });
		const diags = await engine.forFiles(["a.ts"]);
		expect(diags).toHaveLength(1);
		expect(diags[0].source).toBe("ok");
	});

	it("groups detected files by checker for one run per checker", async () => {
		const checker = fakeChecker({
			name: "tsc",
			extensions: [".ts", ".tsx"],
			detect: true,
			diagnostics: [],
		});
		const engine = new DiagnosticsEngine({ cwd: dir, checkers: [checker] });
		await engine.forFiles(["a.ts", "b.tsx", "c.ts"]);
		expect(checker.run).toHaveBeenCalledTimes(1);
		const calledWith = (checker.run as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(calledWith).toEqual(["a.ts", "b.tsx", "c.ts"]);
	});

	it("real go vet detection respects go.mod presence", async () => {
		const { goVetChecker } = await import("./checkers.js");
		expect(await goVetChecker.detect(dir)).toBe(false);
		mkdirSync(join(dir, "deep"), { recursive: true });
		writeFileSync(join(dir, "go.mod"), "module example\n");
		expect(await goVetChecker.detect(dir)).toBe(true);
	});

	it("real tsc detection respects tsconfig.json presence", async () => {
		const { tscChecker } = await import("./checkers.js");
		expect(await tscChecker.detect(dir)).toBe(false);
		writeFileSync(join(dir, "tsconfig.json"), "{}");
		expect(await tscChecker.detect(dir)).toBe(true);
	});
});

describe("formatDiagnostics", () => {
	it("returns empty string for no diagnostics", () => {
		expect(formatDiagnostics([])).toBe("");
	});

	it("groups by file and shows count", () => {
		const out = formatDiagnostics([
			{ file: "src/a.ts", line: 10, column: 5, severity: "error", message: "TS2322", source: "tsc" },
			{ file: "src/a.ts", line: 22, severity: "warning", message: "unused", source: "eslint" },
			{ file: "src/b.ts", line: 1, severity: "error", message: "missing import", source: "tsc" },
		]);
		expect(out).toContain("3 diagnostics after the last edit");
		expect(out).toContain("src/a.ts:");
		expect(out).toContain("Line 10:5 [error] (tsc): TS2322");
		expect(out).toContain("Line 22 [warning] (eslint): unused");
		expect(out).toContain("src/b.ts:");
	});
});
