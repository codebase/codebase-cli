import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

// ─── enter_worktree ──────────────────────────────────────────

const EnterParams = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"Worktree name (used as the branch suffix). Letters, digits, ., _, - only; max 64 chars. Auto-generated if omitted.",
		}),
	),
});

export type EnterWorktreeParams = Static<typeof EnterParams>;

export interface EnterWorktreeDetails {
	name: string;
	path: string;
	branch: string;
}

const ENTER_DESCRIPTION = `Create an isolated git worktree at .worktrees/<name> on a new branch worktree/<name>.

Use this when you want to work on a separate branch in parallel without disturbing the main checkout (e.g., a long-running refactor while reviews land on main).

The new worktree is a full checkout at the current HEAD with its own working tree. After this call returns, point a new codebase session at the printed path to start working there. The agent's current cwd does not move automatically.`;

export function createEnterWorktree(ctx: ToolContext): AgentTool<typeof EnterParams, EnterWorktreeDetails> {
	return {
		name: "enter_worktree",
		label: "Enter worktree",
		description: ENTER_DESCRIPTION,
		parameters: EnterParams,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);
			await assertNotInWorktree(ctx.cwd, signal);

			const name = params.name?.trim() || `wt-${randomBytes(4).toString("hex")}`;
			if (!NAME_PATTERN.test(name)) {
				throw new Error("name must contain only letters, digits, dots, underscores, dashes (max 64 chars).");
			}

			const root = await readGitRoot(ctx.cwd, signal);
			const worktreePath = join(root, ".worktrees", name);
			const branch = `worktree/${name}`;

			const r = await runGit(["worktree", "add", "-b", branch, worktreePath], root, signal);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || `git worktree add exited ${r.exitCode}`);
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Created worktree at ${worktreePath} (branch: ${branch}).\n` +
							"To use it, run codebase from that directory.",
					},
				],
				details: { name, path: resolve(worktreePath), branch },
			};
		},
	};
}

async function assertNotInWorktree(cwd: string, signal?: AbortSignal): Promise<void> {
	const common = await runGit(["rev-parse", "--git-common-dir"], cwd, signal);
	const own = await runGit(["rev-parse", "--git-dir"], cwd, signal);
	if (common.exitCode !== 0 || own.exitCode !== 0) return;
	const a = resolveGitDir(common.stdout.trim(), cwd);
	const b = resolveGitDir(own.stdout.trim(), cwd);
	if (a !== b) {
		throw new Error("Already in a worktree. Run exit_worktree first if you want to leave it.");
	}
}

function resolveGitDir(value: string, cwd: string): string {
	if (!value) return value;
	return value.startsWith("/") ? value : resolve(cwd, value);
}

async function readGitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const r = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	if (r.exitCode !== 0) {
		throw new Error(r.stderr.trim() || "could not find git root");
	}
	return r.stdout.trim();
}

// ─── exit_worktree ───────────────────────────────────────────

const ExitParams = Type.Object({
	action: Type.Union([Type.Literal("keep"), Type.Literal("remove")], {
		description: "keep: leave the worktree on disk (just acknowledge). remove: git worktree remove.",
	}),
	discard_changes: Type.Optional(
		Type.Boolean({
			description: "Force removal even with uncommitted changes. Default false.",
		}),
	),
});

export type ExitWorktreeParams = Static<typeof ExitParams>;

export interface ExitWorktreeDetails {
	action: "keep" | "remove";
	removed: boolean;
	hadUncommittedChanges: boolean;
}

const EXIT_DESCRIPTION = `Exit a worktree created by enter_worktree. Run this from INSIDE the worktree (your codebase session must be cwd'd into it).

action: "keep" leaves the worktree alone — the branch and disk state stay. action: "remove" runs \`git worktree remove\`. If the worktree has uncommitted changes, removal errors unless discard_changes: true.`;

export function createExitWorktree(ctx: ToolContext): AgentTool<typeof ExitParams, ExitWorktreeDetails> {
	return {
		name: "exit_worktree",
		label: "Exit worktree",
		description: EXIT_DESCRIPTION,
		parameters: ExitParams,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);

			if (params.action === "keep") {
				return {
					content: [{ type: "text", text: "Worktree kept. Switch back to the main checkout when ready." }],
					details: { action: "keep", removed: false, hadUncommittedChanges: false },
				};
			}

			const status = await runGit(["status", "--porcelain"], ctx.cwd, signal);
			const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
			if (dirty && !params.discard_changes) {
				throw new Error(
					"worktree has uncommitted changes. Set discard_changes: true to force removal, or commit first.",
				);
			}

			const path = await readGitRoot(ctx.cwd, signal);
			const args = ["worktree", "remove"];
			if (params.discard_changes) args.push("--force");
			args.push(path);

			// Run from the parent (main) repo so we can remove the cwd we're in.
			const main = await readMainRepoDir(ctx.cwd, signal);
			const r = await runGit(args, main, signal);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || `git worktree remove exited ${r.exitCode}`);
			}

			return {
				content: [{ type: "text", text: `Removed worktree ${path}.` }],
				details: { action: "remove", removed: true, hadUncommittedChanges: dirty },
			};
		},
	};
}

async function readMainRepoDir(cwd: string, signal?: AbortSignal): Promise<string> {
	const r = await runGit(["rev-parse", "--git-common-dir"], cwd, signal);
	if (r.exitCode !== 0) return cwd;
	const commonDir = resolveGitDir(r.stdout.trim(), cwd);
	// commonDir is the repo's .git dir; the worktree containing it is its parent.
	return resolve(commonDir, "..");
}
