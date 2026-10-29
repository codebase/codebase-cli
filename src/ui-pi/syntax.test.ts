import { describe, expect, it } from "vitest";
import { detectLanguage, highlightCode, highlightSegments, languageForPath, resolveLanguage } from "./syntax.js";

describe("syntax", () => {
	it("resolves fence aliases and file extensions", () => {
		expect(resolveLanguage("cs")).toBe("cs");
		expect(resolveLanguage("HTML")).toBe("html");
		expect(resolveLanguage("not-a-lang")).toBeUndefined();
		expect(languageForPath("src/App.tsx")).toBe("tsx");
		expect(languageForPath("Makefile")).toBe("makefile");
		expect(languageForPath("notes.unknownext")).toBeUndefined();
	});

	it("colors keywords and decodes entities", () => {
		const [line] = highlightSegments('if (a < b) return "x";', "js");
		expect(line.map((s) => s.text).join("")).toBe('if (a < b) return "x";');
		expect(line.find((s) => s.text === "return")?.style).toBeDefined();
	});

	it("keeps multi-line comments colored on every line without full resets", () => {
		const lines = highlightCode("/* one\ntwo */ int x;", "c");
		expect(lines).toHaveLength(2);
		expect(lines[1].startsWith("\x1b[38;5;")).toBe(true);
		expect(lines.join("")).not.toContain("\x1b[0m");
	});

	it("passes unknown languages through untouched", () => {
		expect(highlightCode("a\nb", undefined)).toEqual(["a", "b"]);
	});
});

describe("detectLanguage", () => {
	it("recognizes shell commands, markup, and code", () => {
		expect(detectLanguage("xdg-open testing/test.html")).toBe("bash");
		expect(detectLanguage('git commit -m "x"\nnpm run build')).toBe("bash");
		expect(detectLanguage("SELECT * FROM t;")).toBe("sql");
		expect(detectLanguage('{"a": 1}')).toBe("json");
		expect(detectLanguage("<div>hi</div>")).toBe("xml");
	});

	it("leaves prose plain", () => {
		expect(detectLanguage("The build passed and all tests are green now")).toBeUndefined();
	});

	it("colors untagged and unknown-tag blocks", () => {
		expect(highlightCode("git status", "test")[0]).toContain("\x1b[38;5;");
	});
});
