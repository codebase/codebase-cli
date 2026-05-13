import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvironmentReminder, buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
	it("includes the identity sentence at the top", () => {
		const out = buildSystemPrompt();
		expect(out.startsWith("You are codebase")).toBe(true);
	});

	it("includes a 'What NOT to do' anti-pattern section", () => {
		const out = buildSystemPrompt();
		expect(out).toContain("# What NOT to do");
		expect(out).toMatch(/Don't add features.*beyond what was asked/);
		expect(out).toMatch(/Don't add error handling.*can't actually occur/);
		expect(out).toMatch(/Default to no comments/);
	});

	it("includes the verification rule", () => {
		const out = buildSystemPrompt();
		expect(out).toContain("# Verifying your work");
		expect(out).toMatch(/never characterize unverified work as complete/i);
	});

	it("explains system-reminder semantics so the model knows they're from the runtime", () => {
		const out = buildSystemPrompt();
		expect(out).toContain("<system-reminder>");
		expect(out).toMatch(/aren't typed by the user/i);
	});

	it("includes the task-checklist policy", () => {
		const out = buildSystemPrompt();
		expect(out).toContain("Task checklist");
		expect(out).toMatch(/Exactly ONE task is in_progress/);
	});

	it("inlines an 'Available tools' section when tools are passed", () => {
		const out = buildSystemPrompt({
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
		const out = buildSystemPrompt();
		expect(out).not.toContain("# Available tools");
	});

	it("does NOT include cwd/platform/host/date/git — those live in the env reminder now", () => {
		const out = buildSystemPrompt();
		expect(out).not.toMatch(/^- cwd:/m);
		expect(out).not.toMatch(/^- platform:/m);
		expect(out).not.toMatch(/^- date:/m);
		expect(out).not.toMatch(/^- git branch:/m);
	});

	it("is byte-stable across calls with the same tool list (essential for prompt-cache hits)", () => {
		const tools = [
			{ name: "read_file", description: "Read." },
			{ name: "shell", description: "Run." },
		];
		const a = buildSystemPrompt({ tools });
		const b = buildSystemPrompt({ tools });
		expect(a).toBe(b);
	});

	it("is byte-stable independent of cwd / date — those are no longer baked in", () => {
		const a = buildSystemPrompt();
		const b = buildSystemPrompt();
		expect(a).toBe(b);
	});
});

describe("buildEnvironmentReminder", () => {
	it("wraps the env block in <system-reminder> tags", () => {
		const out = buildEnvironmentReminder("/tmp");
		expect(out.startsWith("<system-reminder>")).toBe(true);
		expect(out.endsWith("</system-reminder>")).toBe(true);
	});

	it("includes cwd, platform, host, date", () => {
		const out = buildEnvironmentReminder("/home/test");
		expect(out).toContain("- cwd: /home/test");
		expect(out).toMatch(/- platform: /);
		expect(out).toMatch(/- host: /);
		expect(out).toMatch(/- date: \d{4}-\d{2}-\d{2}/);
	});

	it("includes git summary when cwd is a git repo", () => {
		const out = buildEnvironmentReminder(process.cwd());
		expect(out).toMatch(/- git branch: \S/);
		expect(out).toMatch(/- git status: (clean|\d+ uncommitted)/);
	});

	it("omits git lines when cwd is not a git repo", () => {
		const tmp = mkdtempSync(join(tmpdir(), "no-git-"));
		try {
			const out = buildEnvironmentReminder(tmp);
			expect(out).not.toMatch(/- git branch:/);
			expect(out).not.toMatch(/- git status:/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
