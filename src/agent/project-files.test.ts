import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProjectFilesAddendum } from "./project-files.js";

describe("buildProjectFilesAddendum", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "project-files-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns empty string when no recognized file exists", () => {
		expect(buildProjectFilesAddendum(cwd)).toBe("");
	});

	it("loads CLAUDE.md when present", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "# Project Rules\n\nNo cowboy coding.");
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("# Project instructions (CLAUDE.md)");
		expect(out).toContain("No cowboy coding");
	});

	it("loads AGENTS.md when present and prefers it over CLAUDE.md (first match wins)", () => {
		writeFileSync(join(cwd, "AGENTS.md"), "AGENTS RULES");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE RULES");
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("# Project instructions (AGENTS.md)");
		expect(out).toContain("AGENTS RULES");
		expect(out).not.toContain("CLAUDE RULES");
	});

	it("loads CODEX.md when neither AGENTS.md nor CLAUDE.md exists", () => {
		writeFileSync(join(cwd, "CODEX.md"), "CODEX RULES");
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("# Project instructions (CODEX.md)");
		expect(out).toContain("CODEX RULES");
	});

	it("loads .cursorrules as a last resort", () => {
		writeFileSync(join(cwd, ".cursorrules"), "CURSOR RULES");
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("# Project instructions (.cursorrules)");
		expect(out).toContain("CURSOR RULES");
	});

	it("truncates content past the byte cap with a notice", () => {
		const huge = "x".repeat(70 * 1024); // 70KB > 64KB cap
		writeFileSync(join(cwd, "CLAUDE.md"), huge);
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("…truncated");
		expect(out).toContain("CLAUDE.md");
		expect(out.length).toBeLessThan(huge.length);
	});

	it("ignores a directory named CLAUDE.md (not a regular file)", () => {
		mkdirSync(join(cwd, "CLAUDE.md"));
		expect(buildProjectFilesAddendum(cwd)).toBe("");
	});

	it("trims surrounding whitespace from the file content", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "\n\n   rule one  \n\n");
		const out = buildProjectFilesAddendum(cwd);
		expect(out).toContain("rule one");
		// Section structure intact, no leading/trailing spaces on the content body.
		expect(out).toMatch(/\n\nrule one\n\n*$/);
	});
});
