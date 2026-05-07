import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { resolveInsideCwd } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	pattern: Type.String({
		description: "Regex pattern (PCRE2-like via ripgrep). Use fixed_strings: true to disable regex interpretation.",
	}),
	path: Type.Optional(
		Type.String({
			description: "Search root, relative to the project root. Defaults to the project root.",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: 'File glob to scope the search, e.g. "*.ts" or "src/**/*.{ts,tsx}".',
		}),
	),
	case_insensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive match. Default false." })),
	fixed_strings: Type.Optional(
		Type.Boolean({ description: "Treat pattern as a literal string, not regex. Default false." }),
	),
	context_lines: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 10,
			description: "Lines of context around each match (-C flag). Default 0.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Cap on matched lines returned. Default 500.",
		}),
	),
});

export type GrepParams = Static<typeof Params>;

export interface GrepMatch {
	file: string;
	line: number;
	text: string;
}

export interface GrepDetails {
	pattern: string;
	root: string;
	engine: "ripgrep" | "grep";
	matches: GrepMatch[];
	truncated: boolean;
	exitCode: number;
}

const DEFAULT_LIMIT = 500;

const DESCRIPTION = `Search file contents for a pattern.

Behavior:
- Uses ripgrep when available (faster, regex-rich, automatic .gitignore support); falls back to grep -rn.
- Pattern is regex by default; pass fixed_strings: true to match literally.
- Standard build/VCS dirs are skipped automatically (node_modules, .git, dist, target, etc.).
- Results capped at 500 by default; truncation reported in details.
- Output format: "path:line:text", one match per line — easy for the model to quote back to read_file.

Use this for content discovery. For path-pattern lookups use glob, for directory orientation use list_files.`;

export function createGrep(ctx: ToolContext): AgentTool<typeof Params, GrepDetails> {
	return {
		name: "grep",
		label: "Grep",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal) => {
			const root = resolveInsideCwd(ctx.cwd, params.path ?? ".");
			const limit = params.max_results ?? DEFAULT_LIMIT;
			const useRipgrep = await canUseRipgrep();
			const engine: "ripgrep" | "grep" = useRipgrep ? "ripgrep" : "grep";

			const argv = useRipgrep ? buildRipgrepArgs(params) : buildGrepArgs(params);
			const { stdout, stderr, exitCode } = await runChild(argv[0], argv.slice(1), root, signal);

			// rg/grep exit 0 = matches, 1 = no matches, ≥2 = error
			if (exitCode >= 2) {
				const reason = stderr.trim() || `${engine} exited ${exitCode}`;
				throw new Error(reason);
			}

			// rg/grep emit paths relative to the cwd we passed (root). Re-anchor against the project cwd.
			const allMatches = parseMatches(stdout, useRipgrep).map((m) => ({
				...m,
				file: relative(ctx.cwd, resolve(root, m.file)),
			}));
			const truncated = allMatches.length > limit;
			const matches = truncated ? allMatches.slice(0, limit) : allMatches;

			const text = formatOutput(matches, root, ctx.cwd, params.pattern, truncated, allMatches.length, limit);

			return {
				content: [{ type: "text", text }],
				details: {
					pattern: params.pattern,
					root: resolve(root),
					engine,
					matches,
					truncated,
					exitCode,
				},
			};
		},
	};
}

function buildRipgrepArgs(p: GrepParams): string[] {
	const argv = ["rg", "--vimgrep", "--no-heading", "--line-number", "--color=never"];
	if (p.case_insensitive) argv.push("-i");
	if (p.fixed_strings) argv.push("-F");
	if (p.context_lines && p.context_lines > 0) argv.push("-C", String(p.context_lines));
	if (p.glob) argv.push("--glob", p.glob);
	argv.push("--", p.pattern, ".");
	return argv;
}

function buildGrepArgs(p: GrepParams): string[] {
	const argv = ["grep", "-rn", "--color=never"];
	if (p.case_insensitive) argv.push("-i");
	if (p.fixed_strings) argv.push("-F");
	if (p.context_lines && p.context_lines > 0) argv.push("-C", String(p.context_lines));
	if (p.glob) argv.push(`--include=${p.glob}`);
	for (const skip of ["node_modules", ".git", "dist", "build", "target", "__pycache__"]) {
		argv.push(`--exclude-dir=${skip}`);
	}
	argv.push("--", p.pattern, ".");
	return argv;
}

let ripgrepCheck: Promise<boolean> | undefined;
function canUseRipgrep(): Promise<boolean> {
	if (!ripgrepCheck) {
		ripgrepCheck = new Promise((resolveCheck) => {
			const child = spawn("rg", ["--version"], { stdio: "ignore" });
			child.on("error", () => resolveCheck(false));
			child.on("close", (code) => resolveCheck(code === 0));
		});
	}
	return ripgrepCheck;
}

interface ChildResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runChild(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<ChildResult> {
	return new Promise((resolveRun) => {
		const child = spawn(cmd, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (b: Buffer) => out.push(b));
		child.stderr?.on("data", (b: Buffer) => err.push(b));
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort);
		child.on("error", (e) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({ stdout: "", stderr: e.message, exitCode: 1 });
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				exitCode: code ?? 1,
			});
		});
	});
}

interface RawMatch {
	file: string;
	line: number;
	text: string;
}

function parseMatches(stdout: string, ripgrep: boolean): RawMatch[] {
	if (!stdout) return [];
	const matches: RawMatch[] = [];
	for (const raw of stdout.split("\n")) {
		if (!raw) continue;
		const m = ripgrep ? parseRipgrepLine(raw) : parseGrepLine(raw);
		if (m) matches.push(m);
	}
	return matches;
}

function parseRipgrepLine(line: string): RawMatch | null {
	// rg --vimgrep: file:line:col:text
	const first = line.indexOf(":");
	if (first < 0) return null;
	const second = line.indexOf(":", first + 1);
	if (second < 0) return null;
	const third = line.indexOf(":", second + 1);
	if (third < 0) return null;
	const file = line.slice(0, first);
	const lineNum = Number.parseInt(line.slice(first + 1, second), 10);
	if (!Number.isFinite(lineNum)) return null;
	return { file, line: lineNum, text: line.slice(third + 1) };
}

function parseGrepLine(line: string): RawMatch | null {
	// grep -rn: file:line:text  (no column)
	const first = line.indexOf(":");
	if (first < 0) return null;
	const second = line.indexOf(":", first + 1);
	if (second < 0) return null;
	const file = line.slice(0, first);
	const lineNum = Number.parseInt(line.slice(first + 1, second), 10);
	if (!Number.isFinite(lineNum)) return null;
	return { file, line: lineNum, text: line.slice(second + 1) };
}

function formatOutput(
	matches: GrepMatch[],
	root: string,
	cwd: string,
	pattern: string,
	truncated: boolean,
	totalFound: number,
	limit: number,
): string {
	if (matches.length === 0) {
		return `No matches for ${pattern} under ${relative(cwd, root) || "."}`;
	}
	const lines = matches.map((m) => `${m.file}:${m.line}:${m.text}`);
	const tail = truncated ? `\n... (showing ${limit} of ${totalFound} matches)` : "";
	return `${matches.length} match${matches.length === 1 ? "" : "es"}:\n${lines.join("\n")}${tail}`;
}
