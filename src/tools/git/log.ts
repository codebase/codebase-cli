import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const Params = Type.Object({
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description: "Number of commits to show. Default 10, max 200.",
		}),
	),
	oneline: Type.Optional(
		Type.Boolean({
			description: "Compact one-line-per-commit output (--oneline). Default true.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "Limit history to commits touching this path.",
		}),
	),
	ref: Type.Optional(
		Type.String({
			description: "Show history of a specific ref (branch, tag). Defaults to HEAD.",
		}),
	),
});

export type GitLogParams = Static<typeof Params>;

export interface GitLogEntry {
	sha: string;
	subject: string;
}

export interface GitLogDetails {
	count: number;
	entries: GitLogEntry[];
	ref: string | null;
	path: string | null;
}

const DEFAULT_COUNT = 10;

const DESCRIPTION = `Show recent commits. Defaults to 10 most recent on HEAD, in --oneline format (short SHA + subject).

Pass count to fetch more, ref to log a specific branch/tag, or path to filter to commits that touched a file or directory.`;

export function createGitLog(ctx: ToolContext): AgentTool<typeof Params, GitLogDetails> {
	return {
		name: "git_log",
		label: "Git log",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);
			const count = params.count ?? DEFAULT_COUNT;
			const oneline = params.oneline ?? true;

			const argv = ["log", `-n${count}`, "--no-color"];
			if (oneline) argv.push("--oneline");
			if (params.ref) argv.push(params.ref);
			if (params.path) argv.push("--", params.path);

			const r = await runGit(argv, ctx.cwd, signal);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || `git log exited ${r.exitCode}`);
			}

			const entries = oneline ? parseOneline(r.stdout) : [];
			return {
				content: [{ type: "text", text: r.stdout.trim() || "(no commits)" }],
				details: {
					count: oneline ? entries.length : r.stdout.split("\ncommit ").length,
					entries,
					ref: params.ref ?? null,
					path: params.path ?? null,
				},
			};
		},
	};
}

function parseOneline(stdout: string): GitLogEntry[] {
	const entries: GitLogEntry[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const space = line.indexOf(" ");
		if (space === -1) continue;
		entries.push({ sha: line.slice(0, space), subject: line.slice(space + 1) });
	}
	return entries;
}
