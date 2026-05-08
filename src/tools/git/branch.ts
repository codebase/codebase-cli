import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "../types.js";
import { requireGitRepo, runGit } from "./git-helpers.js";

const Params = Type.Object({
	name: Type.Optional(
		Type.String({
			description: "Branch name. Omit to list branches.",
		}),
	),
	create: Type.Optional(
		Type.Boolean({
			description: "Create the branch (errors if it already exists). Requires name.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description: "Base ref for new branches. Defaults to HEAD. Only used with create.",
		}),
	),
});

export type GitBranchParams = Static<typeof Params>;

export interface GitBranchDetails {
	mode: "list" | "create" | "switch";
	branches?: string[];
	current?: string;
	branch?: string;
}

const DESCRIPTION = `Manage git branches.

Modes (selected by which fields you set):
- No name → list local + remote-tracking branches.
- name only → switch to that branch (\`git switch\`). Permission-gated.
- name + create: true → create a new branch (off base or HEAD) and switch to it. Permission-gated.

Listing is read-only and skips the permission prompt. Creating or switching mutates working-tree state and prompts.`;

export function createGitBranch(ctx: ToolContext): AgentTool<typeof Params, GitBranchDetails> {
	return {
		name: "git_branch",
		label: "Git branch",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			await requireGitRepo(ctx.cwd);

			if (!params.name) {
				const r = await runGit(["branch", "-a", "--no-color"], ctx.cwd, signal);
				if (r.exitCode !== 0) {
					throw new Error(r.stderr.trim() || `git branch exited ${r.exitCode}`);
				}
				const { branches, current } = parseBranchList(r.stdout);
				return {
					content: [{ type: "text", text: branches.length ? branches.join("\n") : "(no branches)" }],
					details: { mode: "list", branches, current: current ?? undefined },
				};
			}

			if (params.create) {
				const args = ["switch", "-c", params.name];
				if (params.base) args.push(params.base);
				const r = await runGit(args, ctx.cwd, signal);
				if (r.exitCode !== 0) {
					throw new Error(r.stderr.trim() || `git switch -c ${params.name} exited ${r.exitCode}`);
				}
				return {
					content: [{ type: "text", text: `created and switched to ${params.name}` }],
					details: { mode: "create", branch: params.name },
				};
			}

			const r = await runGit(["switch", params.name], ctx.cwd, signal);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || `git switch ${params.name} exited ${r.exitCode}`);
			}
			return {
				content: [{ type: "text", text: `switched to ${params.name}` }],
				details: { mode: "switch", branch: params.name },
			};
		},
	};
}

function parseBranchList(output: string): { branches: string[]; current: string | null } {
	const branches: string[] = [];
	let current: string | null = null;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("* ")) {
			const name = line.slice(2).trim();
			current = name;
			branches.push(`* ${name}`);
		} else {
			branches.push(`  ${line.replace(/^[+-]\s*/, "")}`);
		}
	}
	return { branches, current };
}
