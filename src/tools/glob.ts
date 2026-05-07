import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { glob } from "glob";
import ignore, { type Ignore } from "ignore";
import { type Static, Type } from "typebox";
import { resolveInsideCwd } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	pattern: Type.String({
		description:
			'Glob pattern, e.g. "**/*.ts", "src/**/test/*.test.tsx", "package.json". Standard globstar (** = any depth) and brace expansion ({a,b}) supported.',
	}),
	path: Type.Optional(
		Type.String({
			description: "Search root, relative to the project root. Defaults to the project root.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Cap on matches returned. Default 500.",
		}),
	),
	respect_gitignore: Type.Optional(
		Type.Boolean({
			description: "Honor .gitignore at the search root and the project root. Default true.",
		}),
	),
});

export type GlobParams = Static<typeof Params>;

export interface GlobDetails {
	pattern: string;
	root: string;
	matches: string[];
	truncated: boolean;
	gitignoreApplied: boolean;
}

const DEFAULT_LIMIT = 500;
const HARDCODED_IGNORES = [
	"**/node_modules/**",
	"**/.git/**",
	"**/.hg/**",
	"**/.svn/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/.next/**",
	"**/.nuxt/**",
	"**/.cache/**",
	"**/.turbo/**",
	"**/__pycache__/**",
	"**/.pytest_cache/**",
	"**/target/**",
	"**/vendor/**",
];

const DESCRIPTION = `Find files matching a glob pattern.

Behavior:
- Standard glob: ** = any directory depth, * = any chars in a segment, {a,b} = alternation, [abc] = char class.
- Search starts from the project root unless path is given (must remain inside the project root).
- Build/VCS metadata directories (node_modules, .git, dist, target, etc.) are excluded by default.
- .gitignore at the search root and project root is honored unless respect_gitignore: false.
- Results are sorted by modification time, newest first, so recently-changed files surface first.
- Results capped at 500 by default; truncation is reported in details.

Use this when you know what kind of file you're looking for. For directory orientation use list_files; for content search use grep.`;

export function createGlob(ctx: ToolContext): AgentTool<typeof Params, GlobDetails> {
	return {
		name: "glob",
		label: "Glob",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const root = resolveInsideCwd(ctx.cwd, params.path ?? ".");
			const limit = params.max_results ?? DEFAULT_LIMIT;
			const useGitignore = params.respect_gitignore !== false;

			const matches = await glob(params.pattern, {
				cwd: root,
				ignore: HARDCODED_IGNORES.slice(),
				dot: false,
				nodir: true,
				absolute: true,
			});

			let kept = matches.map((abs) => relative(ctx.cwd, abs));

			let gitignoreApplied = false;
			if (useGitignore) {
				const ig = loadGitignore(ctx.cwd, root);
				if (ig) {
					gitignoreApplied = true;
					kept = kept.filter((p) => !ig.ignores(p));
				}
			}

			kept.sort((a, b) => mtime(join(ctx.cwd, b)) - mtime(join(ctx.cwd, a)));

			const truncated = kept.length > limit;
			if (truncated) kept = kept.slice(0, limit);

			const tail = truncated ? `\n... (capped at ${limit} of ${matches.length} matches)` : "";
			const text =
				kept.length === 0
					? `No matches for ${params.pattern} under ${relative(ctx.cwd, root) || "."}`
					: `${kept.length} match${kept.length === 1 ? "" : "es"}:\n${kept.join("\n")}${tail}`;

			return {
				content: [{ type: "text", text }],
				details: {
					pattern: params.pattern,
					root: resolve(root),
					matches: kept,
					truncated,
					gitignoreApplied,
				},
			};
		},
	};
}

function loadGitignore(projectRoot: string, searchRoot: string): Ignore | null {
	const ig = ignore();
	let loaded = false;
	for (const candidate of dedupe([projectRoot, searchRoot])) {
		for (const file of [".gitignore", ".git/info/exclude"]) {
			try {
				const body = readFileSync(join(candidate, file), "utf8");
				ig.add(body);
				loaded = true;
			} catch {
				// missing file is fine
			}
		}
	}
	return loaded ? ig : null;
}

function dedupe<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

function mtime(path: string): number {
	try {
		return require("node:fs").statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
