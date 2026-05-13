import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
	it("includes the identity sentence at the top", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out.startsWith("You are codebase")).toBe(true);
	});

	it("includes a 'What NOT to do' anti-pattern section", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out).toContain("# What NOT to do");
		// The specific bullets that should be present:
		expect(out).toMatch(/Don't add features.*beyond what was asked/);
		expect(out).toMatch(/Don't add error handling.*can't actually occur/);
		expect(out).toMatch(/Default to no comments/);
	});

	it("includes the verification rule", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out).toContain("# Verifying your work");
		expect(out).toMatch(/never characterize unverified work as complete/i);
	});

	it("explains system-reminder semantics so the model knows they're from the runtime", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out).toContain("<system-reminder>");
		expect(out).toMatch(/aren't typed by the user/i);
	});

	it("includes the task-checklist policy", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out).toContain("Task checklist");
		expect(out).toMatch(/Exactly ONE task is in_progress/);
	});

	it("inlines an 'Available tools' section when tools are passed", () => {
		const out = buildSystemPrompt({
			cwd: "/tmp",
			tools: [
				{ name: "read_file", description: "Read a file from disk." },
				{ name: "shell", description: "Run a shell command.\n\nMore detail follows on later lines." },
			],
		});
		expect(out).toContain("# Available tools");
		expect(out).toMatch(/- read_file — Read a file from disk\./);
		// Only the first line of each description is included.
		expect(out).toMatch(/- shell — Run a shell command\./);
		expect(out).not.toContain("More detail follows on later lines");
	});

	it("omits the 'Available tools' section when no tools are passed", () => {
		const out = buildSystemPrompt({ cwd: "/tmp" });
		expect(out).not.toContain("# Available tools");
	});

	it("includes an Environment block with cwd / platform / date", () => {
		const out = buildSystemPrompt({ cwd: "/home/test" });
		expect(out).toContain("# Environment");
		expect(out).toContain("- cwd: /home/test");
		expect(out).toMatch(/- date: \d{4}-\d{2}-\d{2}/);
	});

	it("accepts a bare cwd string for backward compatibility", () => {
		const out = buildSystemPrompt("/legacy/cwd");
		expect(out).toContain("- cwd: /legacy/cwd");
	});

	it("does NOT include git lines when cwd is not a git repo", () => {
		const tmp = mkdtempSync(join(tmpdir(), "no-git-"));
		try {
			const out = buildSystemPrompt({ cwd: tmp });
			expect(out).not.toMatch(/^- git branch:/m);
			expect(out).not.toMatch(/^- git status:/m);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("includes git branch + status when cwd is this repo", () => {
		// This test repo IS a git repo, so the helper should find it.
		const out = buildSystemPrompt({ cwd: process.cwd() });
		expect(out).toMatch(/^- git branch: \S/m);
		// status is either "clean" or "N uncommitted changes"
		expect(out).toMatch(/^- git status: (clean|\d+ uncommitted)/m);
	});
});
