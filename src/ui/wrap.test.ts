import { describe, expect, it } from "vitest";
import { wrapText } from "./wrap.js";

describe("wrapText", () => {
	it("returns the text unchanged when it fits", () => {
		expect(wrapText("short", 80)).toEqual(["short"]);
	});

	it("wraps at word boundaries", () => {
		expect(wrapText("hello world this is a long line", 12)).toEqual(["hello world", "this is a", "long line"]);
	});

	it("strips trailing whitespace from wrapped lines", () => {
		const out = wrapText("hello world this", 12);
		for (const line of out) {
			expect(line).not.toMatch(/\s$/);
		}
	});

	it("preserves leading whitespace (indentation)", () => {
		const out = wrapText("    indented function call", 30);
		expect(out[0]).toMatch(/^ {4}indented/);
	});

	it("hard-breaks tokens longer than maxWidth", () => {
		const out = wrapText("https://example.com/path/to/very/long/resource", 12);
		expect(out.length).toBeGreaterThan(1);
		// No line exceeds maxWidth
		for (const line of out) {
			expect(line.length).toBeLessThanOrEqual(12);
		}
	});

	it("preserves explicit newlines as paragraph breaks", () => {
		const text = "first paragraph\n\nsecond paragraph";
		const out = wrapText(text, 80);
		expect(out).toEqual(["first paragraph", "", "second paragraph"]);
	});

	it('returns [""] for empty input', () => {
		expect(wrapText("", 80)).toEqual([""]);
	});

	it("returns split-on-newline when maxWidth is non-positive", () => {
		expect(wrapText("a\nb\nc", 0)).toEqual(["a", "b", "c"]);
	});

	it("handles a code block with mixed indentation", () => {
		const code = "function foo() {\n  return bar;\n  if (x) {\n    return y;\n  }\n}";
		const out = wrapText(code, 80);
		// Indentation preserved
		expect(out).toEqual(["function foo() {", "  return bar;", "  if (x) {", "    return y;", "  }", "}"]);
	});
});
