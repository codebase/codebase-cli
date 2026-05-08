import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "../file-state-cache.js";
import { TaskStore } from "../task-store.js";
import type { ToolContext } from "../types.js";
import { createGitBranch } from "./branch.js";
import { createGitCommit } from "./commit.js";

function makeCtx(cwd: string): ToolContext {
	return {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		spawnSubagent: () => {
			throw new Error("not used in tests");
		},
	};
}

function git(cmd: string, cwd: string): void {
	execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function setupRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-mut-"));
	git("init -q -b main", dir);
	git("config user.email t@t.test", dir);
	git("config user.name tester", dir);
	writeFileSync(join(dir, "README.md"), "# initial\n");
	git("add README.md", dir);
	git("commit -q -m 'initial'", dir);
	return dir;
}

describe("git_commit", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("commits already-staged changes", async () => {
		writeFileSync(join(dir, "a.txt"), "hi\n");
		git("add a.txt", dir);

		const result = await createGitCommit(ctx).execute("c", { message: "add a" }, undefined);
		expect(result.details.subject).toBe("add a");
		expect(result.details.sha).toMatch(/^[a-f0-9]{40}$/);
		expect(result.details.branch).toBe("main");
	});

	it("stages specific files when files= is given", async () => {
		writeFileSync(join(dir, "x.txt"), "x\n");
		writeFileSync(join(dir, "y.txt"), "y\n");

		const result = await createGitCommit(ctx).execute("c", { message: "add x", files: ["x.txt"] }, undefined);
		expect(result.details.subject).toBe("add x");
		const log = execSync("git show --name-only HEAD", { cwd: dir, encoding: "utf8" });
		expect(log).toContain("x.txt");
		expect(log).not.toContain("y.txt");
	});

	it("stages everything when stage_all is true", async () => {
		writeFileSync(join(dir, "x.txt"), "x\n");
		writeFileSync(join(dir, "y.txt"), "y\n");

		await createGitCommit(ctx).execute("c", { message: "all", stage_all: true }, undefined);
		const log = execSync("git show --name-only HEAD", { cwd: dir, encoding: "utf8" });
		expect(log).toContain("x.txt");
		expect(log).toContain("y.txt");
	});

	it("rejects files + stage_all together", async () => {
		await expect(
			createGitCommit(ctx).execute("c", { message: "x", files: ["x"], stage_all: true }, undefined),
		).rejects.toThrow(/files or stage_all/);
	});

	it("preserves multi-line messages via stdin", async () => {
		writeFileSync(join(dir, "z.txt"), "z\n");
		git("add z.txt", dir);

		await createGitCommit(ctx).execute(
			"c",
			{ message: "subject line\n\nbody paragraph here\nwith two lines" },
			undefined,
		);
		const log = execSync("git log -1 --format=%B HEAD", { cwd: dir, encoding: "utf8" });
		expect(log).toContain("subject line");
		expect(log).toContain("body paragraph here");
		expect(log).toContain("with two lines");
	});

	it("errors with git's reason when nothing is staged", async () => {
		await expect(createGitCommit(ctx).execute("c", { message: "nope" }, undefined)).rejects.toThrow(/nothing/i);
	});

	it("rejects when cwd is not a git repo", async () => {
		const bad = mkdtempSync(join(tmpdir(), "norepo-"));
		const badCtx = makeCtx(bad);
		await expect(createGitCommit(badCtx).execute("c", { message: "x" }, undefined)).rejects.toThrow(
			/Not a git repository/,
		);
		rmSync(bad, { recursive: true, force: true });
	});
});

describe("git_branch", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists branches when no name is given", async () => {
		git("branch feat/x", dir);
		const result = await createGitBranch(ctx).execute("b", {}, undefined);
		expect(result.details.mode).toBe("list");
		expect(result.details.current).toBe("main");
		const branches = result.details.branches ?? [];
		expect(branches.some((b) => b.includes("feat/x"))).toBe(true);
		expect(branches.some((b) => b.includes("* main"))).toBe(true);
	});

	it("creates a new branch with create: true", async () => {
		const result = await createGitBranch(ctx).execute("b", { name: "feat/new", create: true }, undefined);
		expect(result.details.mode).toBe("create");
		const head = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8" }).trim();
		expect(head).toBe("feat/new");
	});

	it("switches to an existing branch", async () => {
		git("branch other", dir);
		const result = await createGitBranch(ctx).execute("b", { name: "other" }, undefined);
		expect(result.details.mode).toBe("switch");
		const head = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8" }).trim();
		expect(head).toBe("other");
	});

	it("errors when create-ing an existing branch", async () => {
		git("branch already-here", dir);
		await expect(
			createGitBranch(ctx).execute("b", { name: "already-here", create: true }, undefined),
		).rejects.toThrow();
	});

	it("errors when switching to a missing branch", async () => {
		await expect(createGitBranch(ctx).execute("b", { name: "ghost" }, undefined)).rejects.toThrow();
	});
});
