import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProjectFilesAddendum } from "./project-files.js";

describe("buildProjectFilesAddendum", () => {
	let cwd: string;
	let home: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "project-files-"));
		home = mkdtempSync(join(tmpdir(), "project-files-home-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	function build(): string {
		return buildProjectFilesAddendum(cwd, { home });
	}

	it("returns empty string when no recognized file exists", () => {
		expect(build()).toBe("");
	});

	it("loads CLAUDE.md when present", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "# Project Rules\n\nNo cowboy coding.");
		const out = build();
		expect(out).toContain("# Project instructions (CLAUDE.md)");
		expect(out).toContain("No cowboy coding");
	});

	it("loads AGENTS.md when present and prefers it over CLAUDE.md (first match wins)", () => {
		writeFileSync(join(cwd, "AGENTS.md"), "AGENTS RULES");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE RULES");
		const out = build();
		expect(out).toContain("# Project instructions (AGENTS.md)");
		expect(out).toContain("AGENTS RULES");
		expect(out).not.toContain("CLAUDE RULES");
	});

	it("loads CODEX.md when neither AGENTS.md nor CLAUDE.md exists", () => {
		writeFileSync(join(cwd, "CODEX.md"), "CODEX RULES");
		const out = build();
		expect(out).toContain("# Project instructions (CODEX.md)");
		expect(out).toContain("CODEX RULES");
	});

	it("loads .cursorrules as a last resort", () => {
		writeFileSync(join(cwd, ".cursorrules"), "CURSOR RULES");
		const out = build();
		expect(out).toContain("# Project instructions (.cursorrules)");
		expect(out).toContain("CURSOR RULES");
	});

	it("truncates content past the byte cap with a notice", () => {
		const huge = "x".repeat(70 * 1024); // 70KB > 64KB cap
		writeFileSync(join(cwd, "CLAUDE.md"), huge);
		const out = build();
		expect(out).toContain("…truncated");
		expect(out).toContain("CLAUDE.md");
		expect(out.length).toBeLessThan(huge.length);
	});

	it("ignores a directory named CLAUDE.md (not a regular file)", () => {
		mkdirSync(join(cwd, "CLAUDE.md"));
		expect(build()).toBe("");
	});

	it("trims surrounding whitespace from the file content", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "\n\n   rule one  \n\n");
		const out = build();
		expect(out).toContain("rule one");
	});

	describe("layering", () => {
		it("includes user-level instructions from ~/.codebase/CLAUDE.md before project", () => {
			mkdirSync(join(home, ".codebase"), { recursive: true });
			writeFileSync(join(home, ".codebase", "CLAUDE.md"), "USER PREFS");
			writeFileSync(join(cwd, "CLAUDE.md"), "PROJECT RULES");
			const out = build();
			expect(out).toContain("# User instructions (~/.codebase/CLAUDE.md)");
			expect(out).toContain("USER PREFS");
			expect(out.indexOf("USER PREFS")).toBeLessThan(out.indexOf("PROJECT RULES"));
		});

		it("includes every .codebase/rules/*.md sorted by name", () => {
			mkdirSync(join(cwd, ".codebase", "rules"), { recursive: true });
			writeFileSync(join(cwd, ".codebase", "rules", "20-tests.md"), "TEST RULES");
			writeFileSync(join(cwd, ".codebase", "rules", "10-style.md"), "STYLE RULES");
			const out = build();
			expect(out).toContain("Project rules (.codebase/rules/10-style.md)");
			expect(out).toContain("Project rules (.codebase/rules/20-tests.md)");
			expect(out.indexOf("STYLE RULES")).toBeLessThan(out.indexOf("TEST RULES"));
		});

		it("includes CLAUDE.local.md after project instructions", () => {
			writeFileSync(join(cwd, "CLAUDE.md"), "PROJECT RULES");
			writeFileSync(join(cwd, "CLAUDE.local.md"), "LOCAL OVERRIDES");
			const out = build();
			expect(out).toContain("# Local project instructions (CLAUDE.local.md)");
			expect(out.indexOf("PROJECT RULES")).toBeLessThan(out.indexOf("LOCAL OVERRIDES"));
		});

		it("loads all four layers together", () => {
			mkdirSync(join(home, ".codebase"), { recursive: true });
			mkdirSync(join(cwd, ".codebase", "rules"), { recursive: true });
			writeFileSync(join(home, ".codebase", "AGENTS.md"), "USER");
			writeFileSync(join(cwd, "AGENTS.md"), "PROJECT");
			writeFileSync(join(cwd, ".codebase", "rules", "a.md"), "RULE");
			writeFileSync(join(cwd, "AGENTS.local.md"), "LOCAL");
			const out = build();
			for (const marker of ["USER", "PROJECT", "RULE", "LOCAL"]) expect(out).toContain(marker);
		});
	});

	describe("@imports", () => {
		it("inlines an @./relative import, resolved against the importing file", () => {
			mkdirSync(join(cwd, "docs"));
			writeFileSync(join(cwd, "docs", "api.md"), "API CONVENTIONS BODY");
			writeFileSync(join(cwd, "CLAUDE.md"), "See @./docs/api.md for API rules.");
			const out = build();
			expect(out).toContain("API CONVENTIONS BODY");
			expect(out).toContain("imported from ./docs/api.md");
		});

		it("inlines an @~/ home-relative import", () => {
			writeFileSync(join(home, "style.md"), "HOME STYLE BODY");
			writeFileSync(join(cwd, "CLAUDE.md"), "Style: @~/style.md");
			expect(build()).toContain("HOME STYLE BODY");
		});

		it("recurses into nested imports", () => {
			writeFileSync(join(cwd, "a.md"), "A BODY then @./b.md");
			writeFileSync(join(cwd, "b.md"), "B BODY");
			writeFileSync(join(cwd, "CLAUDE.md"), "@./a.md");
			const out = build();
			expect(out).toContain("A BODY");
			expect(out).toContain("B BODY");
		});

		it("survives circular imports without looping", () => {
			writeFileSync(join(cwd, "a.md"), "A BODY @./b.md");
			writeFileSync(join(cwd, "b.md"), "B BODY @./a.md");
			writeFileSync(join(cwd, "CLAUDE.md"), "@./a.md");
			const out = build();
			expect(out).toContain("A BODY");
			expect(out).toContain("B BODY");
		});

		it("leaves tokens that don't resolve to a file untouched", () => {
			writeFileSync(join(cwd, "CLAUDE.md"), "Email admin@example.com or ping @missing.md please.");
			const out = build();
			expect(out).toContain("admin@example.com");
			expect(out).toContain("@missing.md");
		});

		it("ignores @tokens inside fenced code blocks", () => {
			writeFileSync(join(cwd, "real.md"), "SHOULD NOT APPEAR");
			writeFileSync(join(cwd, "CLAUDE.md"), "```\n@./real.md\n```\n");
			const out = build();
			expect(out).not.toContain("SHOULD NOT APPEAR");
			expect(out).toContain("@./real.md");
		});

		it("does not resolve imports inside .cursorrules", () => {
			writeFileSync(join(cwd, "real.md"), "SHOULD NOT APPEAR");
			writeFileSync(join(cwd, ".cursorrules"), "see @./real.md");
			const out = build();
			expect(out).not.toContain("SHOULD NOT APPEAR");
		});
	});
});
