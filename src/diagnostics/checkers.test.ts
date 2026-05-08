import { describe, expect, it } from "vitest";
import { parseEslint, parseGoVet, parsePyright, parseTsc } from "./checkers.js";

describe("parseGoVet", () => {
	it("parses standard go vet output with line+col", () => {
		const out = "main.go:42:5: missing return at end of function\n";
		const diags = parseGoVet(out, "/repo");
		expect(diags).toEqual([
			{
				file: "main.go",
				line: 42,
				column: 5,
				severity: "error",
				message: "missing return at end of function",
				source: "go vet",
			},
		]);
	});

	it("parses go vet output with only line", () => {
		const out = "pkg/foo.go:10: shadowed variable name\n";
		const diags = parseGoVet(out, "/repo");
		expect(diags).toHaveLength(1);
		expect(diags[0].column).toBeUndefined();
		expect(diags[0].line).toBe(10);
	});

	it("ignores package banner lines", () => {
		const out = ["# example.com/foo", "main.go:5:1: error here"].join("\n");
		const diags = parseGoVet(out, "/repo");
		expect(diags).toHaveLength(1);
		expect(diags[0].file).toBe("main.go");
	});

	it("returns empty for empty input", () => {
		expect(parseGoVet("", "/repo")).toEqual([]);
		expect(parseGoVet("\n\n", "/repo")).toEqual([]);
	});
});

describe("parseTsc", () => {
	it("parses tsc --pretty false output", () => {
		const out = "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
		const diags = parseTsc(out, "/repo");
		expect(diags).toEqual([
			{
				file: "src/foo.ts",
				line: 10,
				column: 5,
				severity: "error",
				message: "TS2322: Type 'string' is not assignable to type 'number'.",
				source: "tsc",
			},
		]);
	});

	it("distinguishes warning from error", () => {
		const out = "src/foo.ts(3,1): warning TS6133: 'x' is declared but never used.\n";
		const diags = parseTsc(out, "/repo");
		expect(diags[0].severity).toBe("warning");
	});

	it("handles tsx files", () => {
		const out = "src/App.tsx(15,3): error TS2304: Cannot find name 'foo'.\n";
		const diags = parseTsc(out, "/repo");
		expect(diags[0].file).toBe("src/App.tsx");
	});

	it("ignores noise lines", () => {
		const out = ["Building project...", "src/a.ts(1,1): error TS1: bad", "Done."].join("\n");
		const diags = parseTsc(out, "/repo");
		expect(diags).toHaveLength(1);
	});
});

describe("parsePyright", () => {
	it("parses pyright JSON and converts 0-based to 1-based", () => {
		const json = JSON.stringify({
			generalDiagnostics: [
				{
					file: "/repo/main.py",
					severity: "error",
					message: "Argument missing for parameter 'x'",
					range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
				},
			],
		});
		const diags = parsePyright(json, "/repo");
		expect(diags).toEqual([
			{
				file: "main.py",
				line: 10,
				column: 5,
				severity: "error",
				message: "Argument missing for parameter 'x'",
				source: "pyright",
			},
		]);
	});

	it("maps severities", () => {
		const json = JSON.stringify({
			generalDiagnostics: [
				{ file: "/repo/a.py", severity: "warning", message: "w", range: { start: { line: 0, character: 0 } } },
				{ file: "/repo/b.py", severity: "information", message: "i", range: { start: { line: 0, character: 0 } } },
				{ file: "/repo/c.py", severity: "error", message: "e", range: { start: { line: 0, character: 0 } } },
			],
		});
		const diags = parsePyright(json, "/repo");
		expect(diags.map((d) => d.severity)).toEqual(["warning", "info", "error"]);
	});

	it("returns empty for malformed JSON", () => {
		expect(parsePyright("not json", "/repo")).toEqual([]);
	});

	it("returns empty for missing diagnostics array", () => {
		expect(parsePyright("{}", "/repo")).toEqual([]);
	});
});

describe("parseEslint", () => {
	it("parses eslint --format json output", () => {
		const json = JSON.stringify([
			{
				filePath: "/repo/src/a.ts",
				messages: [
					{ ruleId: "no-unused-vars", severity: 2, message: "'x' is unused", line: 5, column: 1 },
					{ ruleId: null, severity: 1, message: "Parsing problem", line: 1 },
				],
			},
		]);
		const diags = parseEslint(json, "/repo");
		expect(diags).toEqual([
			{
				file: "src/a.ts",
				line: 5,
				column: 1,
				severity: "error",
				message: "no-unused-vars: 'x' is unused",
				source: "eslint",
			},
			{
				file: "src/a.ts",
				line: 1,
				column: undefined,
				severity: "warning",
				message: "Parsing problem",
				source: "eslint",
			},
		]);
	});

	it("returns empty for empty input", () => {
		expect(parseEslint("", "/repo")).toEqual([]);
	});

	it("returns empty for malformed JSON", () => {
		expect(parseEslint("not json", "/repo")).toEqual([]);
	});
});
