import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOutputStyle, loadOutputStyles } from "./output-styles.js";

describe("loadOutputStyles", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "os-home-"));
		cwd = mkdtempSync(join(tmpdir(), "os-cwd-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeStyle(root: string, name: string, content: string): void {
		const dir = join(root, ".codebase", "output-styles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), content, "utf8");
	}

	it("returns [] when no styles exist", () => {
		expect(loadOutputStyles({ home, cwd })).toEqual([]);
	});

	it("loads a style with frontmatter name + description", () => {
		writeStyle(home, "terse.md", "---\nname: Terse\ndescription: Short answers.\n---\nBe brief.");
		const styles = loadOutputStyles({ home, cwd });
		expect(styles).toHaveLength(1);
		expect(styles[0]).toMatchObject({ id: "terse", name: "Terse", description: "Short answers.", body: "Be brief." });
	});

	it("defaults name to the id when frontmatter omits it", () => {
		writeStyle(home, "report.md", "Write a formal report.");
		const styles = loadOutputStyles({ home, cwd });
		expect(styles[0]).toMatchObject({ id: "report", name: "report", body: "Write a formal report." });
	});

	it("skips empty-body styles", () => {
		writeStyle(home, "blank.md", "---\nname: Blank\n---\n   ");
		expect(loadOutputStyles({ home, cwd })).toEqual([]);
	});

	it("project styles override user styles with the same id", () => {
		writeStyle(home, "voice.md", "user version");
		writeStyle(cwd, "voice.md", "project version");
		const styles = loadOutputStyles({ home, cwd });
		expect(styles).toHaveLength(1);
		expect(styles[0].body).toBe("project version");
	});

	it("getOutputStyle resolves case-insensitively", () => {
		writeStyle(home, "Terse.md", "Be brief.");
		expect(getOutputStyle("TERSE", { home, cwd })?.body).toBe("Be brief.");
		expect(getOutputStyle("nope", { home, cwd })).toBeUndefined();
	});
});
