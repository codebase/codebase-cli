import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const Params = Type.Object({
	staged: Type.Optional(
		Type.Boolean({
			description: "Show staged changes (--cached). Default false (working-tree changes).",
		}),
	),
	ref: Type.Optional(
		Type.String({
			description: "Compare against a specific ref (commit, branch, tag). Mutually exclusive with staged.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "Limit the diff to a path (file or directory).",
		}),
	),
	max_lines: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10000,
			description: "Cap on diff output lines. Default 2000.",
		}),
	),
});

export type GitDiffParams = Static<typeof Params>;

export interface GitDiffDetails {
	mode: "working" | "staged" | "ref";
	ref: string | null;
	path: string | null;
	bytes: number;
	truncated: boolean;
}

const DEFAULT_LINE_LIMIT = 2000;

const DESCRIPTION = `Show a unified diff. Defaults to working-tree vs index. Set staged: true to see staged-vs-HEAD, or ref: <commit/branch/tag> to compare HEAD against that ref. Limit to a path with the path argument.

Output is the raw diff text, capped at 2000 lines by default. Use git_log to find a ref to diff against.`;

export function createGitDiff(ctx: ToolContext): AgentTool<typeof Params, GitDiffDetails> {
	return {
		name: "git_diff",
		label: "Git diff",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);
			if (params.staged && params.ref) {
				throw new Error("Pass either staged or ref, not both.");
			}

			const argv = ["diff", "--no-color"];
			let mode: GitDiffDetails["mode"] = "working";
			if (params.staged) {
				argv.push("--cached");
				mode = "staged";
			} else if (params.ref) {
				argv.push(params.ref);
				mode = "ref";
			}
			if (params.path) {
				argv.push("--", params.path);
			}

			const r = await runGit(argv, ctx.cwd, signal);
			if (r.exitCode !== 0 && r.exitCode !== 1) {
				// 1 means "differences found", which is normal for diff
				throw new Error(r.stderr.trim() || `git diff exited ${r.exitCode}`);
			}

			const limit = params.max_lines ?? DEFAULT_LINE_LIMIT;
			const allLines = r.stdout.split("\n");
			const truncated = allLines.length > limit;
			const shown = truncated ? allLines.slice(0, limit) : allLines;
			const tail = truncated ? `\n... (showing ${limit} of ${allLines.length} lines)` : "";
			const text = shown.join("\n") + tail;

			return {
				content: [{ type: "text", text: text || "(no changes)" }],
				details: {
					mode,
					ref: params.ref ?? null,
					path: params.path ?? null,
					bytes: r.stdout.length,
					truncated,
				},
			};
		},
	};
}
