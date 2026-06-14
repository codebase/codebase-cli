import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { runGit } from "./git/git-helpers.js";

/**
 * Throwaway git worktrees for isolating subagent / tournament file edits
 * so parallel writers can't collide. Each worktree is its own checkout on
 * a fresh branch; settle() removes it again if nothing was left behind.
 */
export interface SubagentWorktree {
	name: string;
	path: string;
	branch: string;
	baseSha: string;
	kept: boolean;
}

/**
 * Create an isolated worktree branched from `baseSha` (defaults to HEAD).
 * Pass an explicit base — e.g. a working-tree snapshot commit — to start
 * the worktree from uncommitted state rather than the last commit.
 */
export async function createSubagentWorktree(
	cwd: string,
	signal?: AbortSignal,
	baseSha?: string,
): Promise<SubagentWorktree> {
	const rootRes = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	if (rootRes.exitCode !== 0) {
		throw new Error("worktree isolation requires a git repository.");
	}
	const root = rootRes.stdout.trim();
	let base = baseSha;
	if (!base) {
		const head = await runGit(["rev-parse", "HEAD"], root, signal);
		if (head.exitCode !== 0) {
			throw new Error("worktree isolation needs at least one commit (git rev-parse HEAD failed).");
		}
		base = head.stdout.trim();
	}
	const name = `sub-${randomBytes(4).toString("hex")}`;
	const path = join(root, ".worktrees", name);
	const branch = `subagent/${name}`;
	const add = await runGit(["worktree", "add", "-b", branch, path, base], root, signal);
	if (add.exitCode !== 0) {
		throw new Error(add.stderr.trim() || `git worktree add exited ${add.exitCode}`);
	}
	return { name, path, branch, baseSha: base, kept: false };
}

/** Remove the worktree if it was left pristine. Returns true when kept (dirty or committed). */
export async function settleWorktree(cwd: string, worktree: SubagentWorktree): Promise<boolean> {
	try {
		const status = await runGit(["status", "--porcelain"], worktree.path);
		const head = await runGit(["rev-parse", "HEAD"], worktree.path);
		const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0;
		const committed = head.exitCode !== 0 || head.stdout.trim() !== worktree.baseSha;
		if (dirty || committed) return true;
		await runGit(["worktree", "remove", worktree.path], cwd);
		await runGit(["branch", "-D", worktree.branch], cwd);
		return false;
	} catch {
		return true;
	}
}

/** Force-remove a worktree and delete its branch, regardless of state (tournament cleanup). */
export async function discardWorktree(cwd: string, worktree: SubagentWorktree): Promise<void> {
	try {
		await runGit(["worktree", "remove", "--force", worktree.path], cwd);
		await runGit(["branch", "-D", worktree.branch], cwd);
	} catch {
		// Best effort — a leftover worktree is reported, not fatal.
	}
}
