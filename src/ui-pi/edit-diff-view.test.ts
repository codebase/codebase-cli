import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderFileEdit } from "./edit-diff-view.js";

const strip = (s: string) =>
	s
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.trimEnd();

describe("renderFileEdit", () => {
	it("numbers written lines and clips long files", () => {
		const out = renderFileEdit("w1", "write_file", { path: "a.txt", content: "x\n".repeat(14) }, 80)?.map(strip);
		expect(out?.[0]).toBe("● Write(a.txt)");
		expect(out?.[1]).toBe("  ⎿  Wrote 14 lines");
		expect(out?.[2]).toBe("      1 + x");
		expect(out?.at(-1)).toBe("     … +4 lines");
	});

	it("shows edits at their file line numbers with surrounding context", () => {
		// A long path wraps the `Update(<path>)` header (as macOS temp paths do),
		// so the body is located by its summary row, not by a fixed header height.
		const dir = join(mkdtempSync(join(tmpdir(), "edit-diff-")), "a-long-directory-name-that-makes-the-header-wrap");
		mkdirSync(dir);
		const file = join(dir, "f.txt");
		writeFileSync(file, "one\ntwo\nTHREE\nfour\nfive\n");
		const out =
			renderFileEdit("e1", "edit_file", { path: file, old_string: "three", new_string: "THREE" }, 80)?.map(strip) ??
			[];
		const summary = out.findIndex((line) => line.trimStart().startsWith("⎿"));
		expect(summary).toBeGreaterThan(1);
		expect(out.slice(summary)).toEqual([
			"  ⎿  Added 1 line, removed 1 line",
			"     1   one",
			"     2   two",
			"     3 - three",
			"     3 + THREE",
			"     4   four",
			"     5   five",
		]);
	});

	it("falls back to an unnumbered diff when the file can't be read", () => {
		const out = renderFileEdit(
			"e2",
			"edit_file",
			{ path: "/nonexistent/x", old_string: "a", new_string: "b" },
			80,
		)?.map(strip);
		expect(out?.slice(2)).toEqual(["      - a", "      + b"]);
	});

	it("colors an edit by the whole file, so CSS inside <style> is highlighted like a write", () => {
		const dir = mkdtempSync(join(tmpdir(), "edit-diff-"));
		const file = join(dir, "page.html");
		writeFileSync(file, "<html>\n<style>\n  body { color: red; }\n</style>\n</html>\n");
		const args = { path: file, old_string: "color: blue;", new_string: "color: red;" };
		const added = renderFileEdit("e3", "edit_file", args, 80)?.find((l) => strip(l).includes("3 +"));
		// "color" is a CSS property: it only gets a color when the <style> context is known.
		expect(added).toMatch(/\x1b\[38;5;\d+mcolor/);
	});
});
