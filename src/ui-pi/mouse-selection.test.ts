import { describe, expect, it } from "vitest";
import { MouseSelection, sliceColumns, stripAnsi } from "./mouse-selection.js";

const lines = ["  hello world", "  \x1b[32mgreen\x1b[0m line   ", "  third"];

describe("MouseSelection", () => {
	it("extracts plain text across rows, trimming trailing spaces", () => {
		const sel = new MouseSelection();
		sel.press(0, 8);
		sel.drag(2, 4);
		expect(sel.release(lines)).toBe("world\n  green line\n  thi");
	});

	it("selects backwards the same as forwards", () => {
		const sel = new MouseSelection();
		sel.press(1, 6);
		sel.drag(0, 2);
		expect(sel.release(lines)).toBe("hello world\n  green");
	});

	it("treats a click without a drag as no selection", () => {
		const sel = new MouseSelection();
		sel.press(0, 3);
		expect(sel.release(lines)).toBeUndefined();
		expect(sel.active).toBe(false);
	});

	it("paints the selection inverse and keeps colors outside it", () => {
		const sel = new MouseSelection();
		sel.press(1, 4);
		sel.drag(1, 5);
		const row = sel.paint(lines)[1];
		expect(row).toContain("\x1b[7mee\x1b[0m");
		expect(stripAnsi(row)).toBe(stripAnsi(lines[1]));
		expect(row.indexOf("\x1b[32m")).toBeLessThan(row.indexOf("\x1b[7m"));
	});
});

describe("sliceColumns", () => {
	it("slices by display width", () => {
		expect(sliceColumns("ab界cd", 2, 4)).toBe("界");
		expect(sliceColumns("abc", 1, Number.POSITIVE_INFINITY)).toBe("bc");
	});
});
