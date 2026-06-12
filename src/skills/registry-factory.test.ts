import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAssetRegistry } from "./registry-factory.js";

describe("buildAssetRegistry", () => {
	let localRoot: string;
	let projectRoot: string;

	beforeEach(() => {
		localRoot = mkdtempSync(join(tmpdir(), "assets-user-"));
		projectRoot = mkdtempSync(join(tmpdir(), "assets-project-"));
	});
	afterEach(() => {
		rmSync(localRoot, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("merges user and project skills", async () => {
		mkdirSync(join(localRoot, "skills"), { recursive: true });
		mkdirSync(join(projectRoot, ".codebase", "skills"), { recursive: true });
		writeFileSync(join(localRoot, "skills", "mine.md"), "user skill");
		writeFileSync(join(projectRoot, ".codebase", "skills", "deploy.md"), "project skill");
		const registry = buildAssetRegistry({ localRoot, projectRoot });
		const skills = await registry.listSkills();
		expect(skills.map((s) => s.id).sort()).toEqual(["deploy", "mine"]);
	});

	it("project skill shadows a user skill with the same id", async () => {
		mkdirSync(join(localRoot, "skills"), { recursive: true });
		mkdirSync(join(projectRoot, ".codebase", "skills"), { recursive: true });
		writeFileSync(join(localRoot, "skills", "deploy.md"), "user version");
		writeFileSync(join(projectRoot, ".codebase", "skills", "deploy.md"), "project version");
		const registry = buildAssetRegistry({ localRoot, projectRoot });
		const skills = await registry.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0].source).toBe("project");
		expect(skills[0].systemPrompt).toContain("project version");
	});
});
