import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const Params = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "Commit message. Multi-line messages are written via -F to preserve formatting.",
	}),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific paths to stage before commit. Mutually exclusive with stage_all.",
		}),
	),
	stage_all: Type.Optional(
		Type.Boolean({
			description: "Run `git add -A` before commit. Mutually exclusive with files.",
		}),
	),
});

export type GitCommitParams = Static<typeof Params>;

export interface GitCommitDetails {
	sha: string | null;
	subject: string;
	branch: string | null;
}

const DESCRIPTION = `Create a git commit. Permission-gated.

Behavior:
- If files is set, runs \`git add <paths>\` first, then commits only those.
- If stage_all is set, runs \`git add -A\` first.
- If neither is set, commits whatever's currently staged.
- Multi-line messages are passed via -F (a temp file) to preserve formatting.
- Pre-commit hooks run normally; their failure stderr surfaces to you.
- Errors with "nothing to commit" if the index is empty after staging.`;

export function createGitCommit(ctx: ToolContext): AgentTool<typeof Params, GitCommitDetails> {
	return {
		name: "git_commit",
		label: "Git commit",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);

			if (params.files && params.stage_all) {
				throw new Error("Pass files or stage_all, not both.");
			}

			if (params.stage_all) {
				const r = await runGit(["add", "-A"], ctx.cwd, signal);
				if (r.exitCode !== 0) {
					throw new Error(r.stderr.trim() || `git add -A exited ${r.exitCode}`);
				}
			} else if (params.files && params.files.length > 0) {
				const r = await runGit(["add", "--", ...params.files], ctx.cwd, signal);
				if (r.exitCode !== 0) {
					throw new Error(r.stderr.trim() || `git add exited ${r.exitCode}`);
				}
			}

			const commit = await runGit(["commit", "-F", "-"], ctx.cwd, signal, params.message);
			if (commit.exitCode !== 0) {
				const stderr = commit.stderr.trim();
				const stdout = commit.stdout.trim();
				const reason = stderr || stdout || `git commit exited ${commit.exitCode}`;
				throw new Error(reason);
			}

			const subject = params.message.split("\n")[0] ?? "";
			const sha = await readHeadSha(ctx.cwd, signal);
			const branch = await readCurrentBranch(ctx.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text:
							sha && branch ? `committed ${sha.slice(0, 7)} on ${branch}: ${subject}` : `committed: ${subject}`,
					},
				],
				details: { sha, subject, branch },
			};
		},
	};
}

async function readHeadSha(cwd: string, signal?: AbortSignal): Promise<string | null> {
	const r = await runGit(["rev-parse", "HEAD"], cwd, signal);
	if (r.exitCode !== 0) return null;
	return r.stdout.trim() || null;
}

async function readCurrentBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
	const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal);
	if (r.exitCode !== 0) return null;
	const branch = r.stdout.trim();
	return branch && branch !== "HEAD" ? branch : null;
}
