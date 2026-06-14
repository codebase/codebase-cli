import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../tools/git/git-helpers.js";

/**
 * Snapshot the current working tree — tracked changes AND untracked files
 * (minus gitignored) — into a dangling commit, without touching the
 * user's index, working tree, or stash. The returned SHA can seed
 * worktrees so parallel agents start from the in-progress state rather
 * than the last commit. Used by /tournament for mid-build runs.
 *
 * Done with a scratch index (GIT_INDEX_FILE) so `git add -A` never
 * disturbs what the user has staged. The commit is left dangling; git GC
 * reclaims it once no worktree references it.
 */
export interface WorkingTreeSnapshot {
	/** Commit SHA capturing the full working-tree state. */
	sha: string;
	/** The HEAD it was based on, for diffing/cleanup. */
	headSha: string;
	/** True if the working tree had no changes (snapshot === HEAD's tree). */
	clean: boolean;
}

export async function snapshotWorkingTree(cwd: string, signal?: AbortSignal): Promise<WorkingTreeSnapshot> {
	const rootRes = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	if (rootRes.exitCode !== 0) throw new Error("not a git repository");
	const root = rootRes.stdout.trim();

	const headRes = await runGit(["rev-parse", "HEAD"], root, signal);
	if (headRes.exitCode !== 0) throw new Error("repository has no commits yet — make one before /tournament");
	const headSha = headRes.stdout.trim();

	const scratchIndex = join(tmpdir(), `codebase-tourney-index-${randomBytes(6).toString("hex")}`);
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex };
	try {
		// Seed the scratch index with HEAD, then stage every working-tree
		// change (including untracked, excluding ignored) into it.
		const seed = await runGit(["read-tree", "HEAD"], root, signal, undefined, env);
		if (seed.exitCode !== 0) throw new Error(`read-tree failed: ${seed.stderr.trim()}`);
		const add = await runGit(["add", "-A"], root, signal, undefined, env);
		if (add.exitCode !== 0) throw new Error(`add failed: ${add.stderr.trim()}`);
		const writeTree = await runGit(["write-tree"], root, signal, undefined, env);
		if (writeTree.exitCode !== 0) throw new Error(`write-tree failed: ${writeTree.stderr.trim()}`);
		const tree = writeTree.stdout.trim();

		const headTreeRes = await runGit(["rev-parse", "HEAD^{tree}"], root, signal);
		const clean = headTreeRes.exitCode === 0 && headTreeRes.stdout.trim() === tree;

		const commit = await runGit(
			["commit-tree", tree, "-p", headSha, "-m", "codebase tournament base (working-tree snapshot)"],
			root,
			signal,
			undefined,
			env,
		);
		if (commit.exitCode !== 0) throw new Error(`commit-tree failed: ${commit.stderr.trim()}`);
		return { sha: commit.stdout.trim(), headSha, clean };
	} finally {
		try {
			rmSync(scratchIndex, { force: true });
		} catch {
			// scratch index in tmp — fine to leave if removal races
		}
	}
}
