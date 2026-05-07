import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { resolveInsideCwd } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "Directory to list, relative to the project root. Defaults to the project root.",
		}),
	),
	recursive: Type.Optional(
		Type.Boolean({
			description: "Walk subdirectories. Default false.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Cap on entries returned. Default 500.",
		}),
	),
});

export type ListFilesParams = Static<typeof Params>;

export interface ListFilesEntry {
	path: string;
	type: "file" | "dir";
	bytes: number;
}

export interface ListFilesDetails {
	root: string;
	entries: ListFilesEntry[];
	truncated: boolean;
}

const DEFAULT_LIMIT = 500;
const IGNORED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".idea",
	".next",
	".nuxt",
	".pytest_cache",
	".turbo",
	".venv",
	".vscode",
	"__pycache__",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
	"venv",
]);

const DESCRIPTION = `List entries in a directory. Defaults to the project root.

Behavior:
- Files and subdirectories returned as paths relative to the project root.
- Directory entries end with "/".
- Subdirectories with build/cache/VCS metadata (node_modules, .git, dist, target, etc.) are skipped automatically.
- Set recursive: true to walk subtrees. Output is capped (default 500); the truncation is reported in details.

Use this for orientation. For pattern-based discovery use the glob tool, and for content search use grep.`;

export function createListFiles(ctx: ToolContext): AgentTool<typeof Params, ListFilesDetails> {
	return {
		name: "list_files",
		label: "List",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const root = resolveInsideCwd(ctx.cwd, params.path ?? ".");
			const limit = params.max_results ?? DEFAULT_LIMIT;
			const recursive = params.recursive ?? false;

			const entries: ListFilesEntry[] = [];
			let truncated = false;

			const walk = (dir: string): void => {
				if (entries.length >= limit) {
					truncated = true;
					return;
				}
				let names: string[];
				try {
					names = readdirSync(dir).sort();
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					throw new Error(`Cannot list ${relative(ctx.cwd, dir) || "."}: ${reason}`);
				}
				for (const name of names) {
					if (entries.length >= limit) {
						truncated = true;
						return;
					}
					const abs = join(dir, name);
					let stat: ReturnType<typeof statSync>;
					try {
						stat = statSync(abs);
					} catch {
						continue;
					}
					const rel = relative(ctx.cwd, abs);
					if (stat.isDirectory()) {
						if (IGNORED_DIRS.has(name)) continue;
						entries.push({ path: `${rel}/`, type: "dir", bytes: 0 });
						if (recursive) walk(abs);
					} else if (stat.isFile()) {
						entries.push({ path: rel, type: "file", bytes: stat.size });
					}
				}
			};

			walk(root);

			const lines = entries.map((e) => e.path);
			const tail = truncated ? `\n... (capped at ${limit} entries)` : "";
			return {
				content: [
					{
						type: "text",
						text: `${entries.length} entries under ${relative(ctx.cwd, root) || "."}:\n${lines.join("\n")}${tail}`,
					},
				],
				details: {
					root: resolve(root),
					entries,
					truncated,
				},
			};
		},
	};
}
