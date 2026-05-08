import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "../file-state-cache.js";
import { TaskStore } from "../task-store.js";
import type { ToolContext } from "../types.js";
import { createEnterWorktree, createExitWorktree } from "./worktree.js";

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
	const dir = mkdtempSync(join(tmpdir(), "git-wt-"));
	git("init -q -b main", dir);
	git("config user.email t@t.test", dir);
	git("config user.name tester", dir);
	writeFileSync(join(dir, "README.md"), "# initial\n");
	git("add README.md", dir);
	git("commit -q -m 'initial'", dir);
	return dir;
}

describe("enter_worktree", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates a worktree at .worktrees/<name> on branch worktree/<name>", async () => {
		const result = await createEnterWorktree(ctx).execute("e", { name: "feat" }, undefined);
		expect(result.details.name).toBe("feat");
		expect(result.details.branch).toBe("worktree/feat");
		expect(existsSync(result.details.path)).toBe(true);
	});

	it("auto-generates a name when omitted", async () => {
		const result = await createEnterWorktree(ctx).execute("e", {}, undefined);
		expect(result.details.name).toMatch(/^wt-[a-f0-9]{8}$/);
	});

	it("rejects invalid names", async () => {
		await expect(createEnterWorktree(ctx).execute("e", { name: "bad name with spaces" }, undefined)).rejects.toThrow(
			/letters, digits/,
		);
	});

	it("rejects when already inside a worktree", async () => {
		await createEnterWorktree(ctx).execute("e", { name: "outer" }, undefined);
		const innerCtx = makeCtx(join(dir, ".worktrees", "outer"));

		await expect(createEnterWorktree(innerCtx).execute("e", { name: "inner" }, undefined)).rejects.toThrow(
			/Already in a worktree/,
		);
	});

	it("rejects when cwd is not a git repo", async () => {
		const bad = mkdtempSync(join(tmpdir(), "norepo-"));
		const badCtx = makeCtx(bad);
		await expect(createEnterWorktree(badCtx).execute("e", { name: "x" }, undefined)).rejects.toThrow(
			/Not a git repository/,
		);
		rmSync(bad, { recursive: true, force: true });
	});
});

describe("exit_worktree", () => {
	let dir: string;
	let ctx: ToolContext;
	let worktreePath: string;
	let worktreeCtx: ToolContext;

	beforeEach(async () => {
		dir = setupRepo();
		ctx = makeCtx(dir);
		const wt = await createEnterWorktree(ctx).execute("e", { name: "scratch" }, undefined);
		worktreePath = wt.details.path;
		worktreeCtx = makeCtx(worktreePath);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("keep action leaves the worktree on disk", async () => {
		const result = await createExitWorktree(worktreeCtx).execute("x", { action: "keep" }, undefined);
		expect(result.details.removed).toBe(false);
		expect(existsSync(worktreePath)).toBe(true);
	});

	it("remove action deletes a clean worktree", async () => {
		const result = await createExitWorktree(worktreeCtx).execute("x", { action: "remove" }, undefined);
		expect(result.details.removed).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
	});

	it("refuses to remove a dirty worktree without discard_changes", async () => {
		writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted\n");
		await expect(createExitWorktree(worktreeCtx).execute("x", { action: "remove" }, undefined)).rejects.toThrow(
			/uncommitted changes/,
		);
		expect(existsSync(worktreePath)).toBe(true);
	});

	it("removes a dirty worktree when discard_changes is true", async () => {
		writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted\n");
		const result = await createExitWorktree(worktreeCtx).execute(
			"x",
			{ action: "remove", discard_changes: true },
			undefined,
		);
		expect(result.details.removed).toBe(true);
		expect(result.details.hadUncommittedChanges).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
	});
});
