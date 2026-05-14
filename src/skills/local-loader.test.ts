import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLoader } from "./local-loader.js";

describe("LocalLoader", () => {
	let root: string;
	let skillsDir: string;
	let templatesDir: string;
	let promptsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codebase-skills-"));
		skillsDir = join(root, "skills");
		templatesDir = join(root, "templates");
		promptsDir = join(root, "prompts");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns [] when no directories exist", async () => {
		const loader = new LocalLoader(root);
		await expect(loader.listSkills()).resolves.toEqual([]);
		await expect(loader.listTemplates()).resolves.toEqual([]);
		await expect(loader.listPrompts()).resolves.toEqual([]);
	});

	it("loads a skill with full frontmatter", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, "optimize.md"),
			[
				"---",
				"id: optimize",
				"name: Optimize hot path",
				"description: Refactor for performance",
				"tags: [perf, refactor]",
				'preferredModel: "claude-opus-4-7"',
				"---",
				"",
				"You are a performance-focused engineer. Trim allocations.",
				"",
			].join("\n"),
		);
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		const s = skills[0];
		expect(s.id).toBe("optimize");
		expect(s.name).toBe("Optimize hot path");
		expect(s.description).toBe("Refactor for performance");
		expect(s.tags).toEqual(["perf", "refactor"]);
		expect(s.preferredModel).toBe("claude-opus-4-7");
		expect(s.systemPrompt).toContain("performance-focused");
		expect(s.source).toBe("user");
	});

	it("falls back to filename as id when frontmatter omits it", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "summarize.md"), "Summarize the changes clearly.");
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0].id).toBe("summarize");
		expect(skills[0].name).toBe("summarize");
		expect(skills[0].systemPrompt).toBe("Summarize the changes clearly.");
	});

	it("loads a template + prompt from their respective dirs", async () => {
		mkdirSync(templatesDir, { recursive: true });
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(
			join(templatesDir, "nextjs.md"),
			["---", "name: Next.js app", "---", "", "Scaffold a Next.js 15 project with app router."].join("\n"),
		);
		writeFileSync(
			join(promptsDir, "explain-diff.md"),
			["---", "name: Explain my diff", "---", "", "Explain the staged diff in plain English."].join("\n"),
		);
		const loader = new LocalLoader(root);
		const templates = await loader.listTemplates();
		const prompts = await loader.listPrompts();
		expect(templates).toHaveLength(1);
		expect(templates[0].kind).toBe("template");
		expect(templates[0].name).toBe("Next.js app");
		expect(prompts).toHaveLength(1);
		expect(prompts[0].kind).toBe("prompt");
		expect(prompts[0].body).toContain("staged diff");
	});

	it("ignores non-md files", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "README"), "documentation");
		writeFileSync(join(skillsDir, "junk.txt"), "ignored");
		writeFileSync(join(skillsDir, "real.md"), "real skill body");
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0].id).toBe("real");
	});

	it("supports a file with no frontmatter at all", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "raw.md"), "Just the body, nothing else.\n");
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0].id).toBe("raw");
		expect(skills[0].systemPrompt).toBe("Just the body, nothing else.\n");
	});

	it("supports a file whose frontmatter is never closed (treats whole file as body)", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "broken.md"), "---\nid: oops\nname: missing close\n\nstill body");
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0].id).toBe("broken"); // falls back to filename, since no frontmatter recognized
	});

	it("parses bare-string and bracketed-list values", async () => {
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, "test.md"),
			["---", "name: My Skill", "tags: [a, b, c]", "---", "", "body"].join("\n"),
		);
		const loader = new LocalLoader(root);
		const skills = await loader.listSkills();
		expect(skills[0].name).toBe("My Skill");
		expect(skills[0].tags).toEqual(["a", "b", "c"]);
	});
});
