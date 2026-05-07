import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const Params = Type.Object({});
export type GitStatusParams = Static<typeof Params>;

export interface GitStatusEntry {
	staged: string;
	unstaged: string;
	path: string;
}

export interface GitStatusDetails {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	clean: boolean;
	entries: GitStatusEntry[];
}

const DESCRIPTION = `Show the working tree status: current branch, upstream tracking, ahead/behind counts, and the list of staged/unstaged/untracked files.

Output mirrors \`git status --short --branch\`. Two-character prefix per file: first column = staged change (M/A/D/R/?), second = unstaged change. ?? means untracked.`;

export function createGitStatus(ctx: ToolContext): AgentTool<typeof Params, GitStatusDetails> {
	return {
		name: "git_status",
		label: "Git status",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_id, _params, signal) => {
			await requireGitRepo(ctx.cwd);
			const r = await runGit(["status", "--short", "--branch"], ctx.cwd, signal);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || `git status exited ${r.exitCode}`);
			}

			const lines = r.stdout.split("\n").filter(Boolean);
			let branch: string | null = null;
			let upstream: string | null = null;
			let ahead = 0;
			let behind = 0;
			const entries: GitStatusEntry[] = [];

			for (const line of lines) {
				if (line.startsWith("##")) {
					const parsed = parseBranchLine(line);
					branch = parsed.branch;
					upstream = parsed.upstream;
					ahead = parsed.ahead;
					behind = parsed.behind;
				} else if (line.length >= 3) {
					entries.push({
						staged: line[0],
						unstaged: line[1],
						path: line.slice(3).trim(),
					});
				}
			}

			const clean = entries.length === 0;
			const summary = formatSummary(branch, upstream, ahead, behind, entries, clean);
			return {
				content: [{ type: "text", text: summary }],
				details: { branch, upstream, ahead, behind, clean, entries },
			};
		},
	};
}

function parseBranchLine(line: string): {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
} {
	// Examples:
	//   ## main
	//   ## main...origin/main
	//   ## main...origin/main [ahead 2, behind 1]
	//   ## HEAD (no branch)
	const body = line.slice(2).trim();
	if (body.startsWith("HEAD")) {
		return { branch: null, upstream: null, ahead: 0, behind: 0 };
	}
	const bracketIdx = body.indexOf("[");
	const head = (bracketIdx === -1 ? body : body.slice(0, bracketIdx)).trim();
	const [branch, upstream = null] = head.split("...");
	let ahead = 0;
	let behind = 0;
	if (bracketIdx !== -1) {
		const inner = body.slice(bracketIdx + 1, body.lastIndexOf("]"));
		const aheadMatch = inner.match(/ahead (\d+)/);
		const behindMatch = inner.match(/behind (\d+)/);
		if (aheadMatch) ahead = Number.parseInt(aheadMatch[1], 10);
		if (behindMatch) behind = Number.parseInt(behindMatch[1], 10);
	}
	return { branch: branch || null, upstream, ahead, behind };
}

function formatSummary(
	branch: string | null,
	upstream: string | null,
	ahead: number,
	behind: number,
	entries: GitStatusEntry[],
	clean: boolean,
): string {
	const lines: string[] = [];
	if (branch) {
		const tracking = upstream ? ` → ${upstream}` : "";
		const drift = ahead || behind ? ` [ahead ${ahead}, behind ${behind}]` : "";
		lines.push(`On ${branch}${tracking}${drift}`);
	} else {
		lines.push("Detached HEAD");
	}
	if (clean) {
		lines.push("Working tree clean.");
	} else {
		for (const e of entries) {
			lines.push(`  ${e.staged}${e.unstaged} ${e.path}`);
		}
	}
	return lines.join("\n");
}
