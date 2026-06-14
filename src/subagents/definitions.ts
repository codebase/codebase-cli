import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Effort, resolveEffort } from "../agent/effort.js";
import { parseMarkdownWithFrontmatter } from "../config/frontmatter.js";

/**
 * Subagent type definitions for dispatch_agent. Two built-ins ship with
 * the CLI; users add custom types as markdown files in
 * `~/.codebase/agents/*.md` (user) or `<cwd>/.codebase/agents/*.md`
 * (project, wins on name clash):
 *
 *   ---
 *   description: Reviews changed code for security issues.
 *   tools: read_file, grep, glob, git_diff
 *   model: claude-haiku-4-5-20251001
 *   effort: high
 *   max_turns: 40
 *   ---
 *   You are a security reviewer. Hunt for injection, authz bypasses,
 *   secrets in code. Cite file:line for every finding.
 *
 * The body becomes the agent's role prompt. `tools` (optional) narrows
 * the toolset; names must come from the subagent-allowed set — anything
 * else is dropped with a stderr note. Omitting `tools` grants the
 * general set. Built-in names can't be overridden. `model` / `effort` /
 * `max_turns` are optional per-agent overrides (model routes through the
 * parent's provider/proxy with a swapped id; a per-call max_turns still
 * wins over the frontmatter default).
 */

export interface SubagentDefinition {
	name: string;
	description: string;
	source: "builtin" | "user" | "project";
	/** Tool names this agent may use. Always a subset of GENERAL_TOOLS. */
	tools: readonly string[];
	/** Role prompt appended to the subagent system prompt (custom types). */
	prompt?: string;
	/**
	 * Per-agent overrides from frontmatter, all optional:
	 * - `model`: route this agent through a different model id (same
	 *   provider / proxy as the parent — e.g. a cheap fast model for triage).
	 * - `effort`: reasoning level for this agent's turns.
	 * - `maxTurns`: default turn cap (a per-call max_turns still wins).
	 */
	model?: string;
	effort?: Effort;
	maxTurns?: number;
}

/** Read-only investigation set — the classic dispatch_agent toolkit. */
export const EXPLORE_TOOLS: readonly string[] = [
	"read_file",
	"list_files",
	"glob",
	"grep",
	"web_fetch",
	"web_search",
	"git_status",
	"git_diff",
	"git_log",
	"list_tasks",
	"get_task",
];

/**
 * Write-capable set. Everything in EXPLORE plus file mutation, shell,
 * and commits. Deliberately excluded: dispatch_agent (no recursion),
 * ask_user / plan tools (no nested interactive flows), monitor
 * (notifications route to the parent UI), memory/config (session-scoped
 * state belongs to the main agent).
 */
export const GENERAL_TOOLS: readonly string[] = [
	...EXPLORE_TOOLS,
	"edit_file",
	"multi_edit",
	"write_file",
	"notebook_edit",
	"shell",
	"shell_output",
	"shell_kill",
	"git_commit",
	"ssh_exec",
];

const BUILTINS: readonly SubagentDefinition[] = [
	{
		name: "explore",
		description: "Read-only investigator: search, read, and report. Default.",
		source: "builtin",
		tools: EXPLORE_TOOLS,
	},
	{
		name: "general",
		description: "Full worker: can edit files, run shell commands, and commit.",
		source: "builtin",
		tools: GENERAL_TOOLS,
	},
];

export interface LoadSubagentOptions {
	home?: string;
	cwd?: string;
}

export function loadSubagentDefinitions(options: LoadSubagentOptions = {}): SubagentDefinition[] {
	const home = options.home ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const byName = new Map<string, SubagentDefinition>();
	for (const def of BUILTINS) byName.set(def.name, def);
	// User layer first, then project so project wins on name collision —
	// but never over a builtin.
	for (const [dir, source] of [
		[join(home, ".codebase", "agents"), "user"],
		[join(cwd, ".codebase", "agents"), "project"],
	] as const) {
		for (const def of readAgentDir(dir, source)) {
			if (BUILTINS.some((b) => b.name === def.name)) {
				process.stderr.write(`[agents] skipping "${def.name}": built-in agent types can't be overridden.\n`);
				continue;
			}
			byName.set(def.name, def);
		}
	}
	return Array.from(byName.values());
}

const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function readAgentDir(dir: string, source: "user" | "project"): SubagentDefinition[] {
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((n) => n.endsWith(".md"));
	} catch {
		return [];
	}
	const out: SubagentDefinition[] = [];
	for (const filename of entries.sort()) {
		const path = join(dir, filename);
		try {
			if (!statSync(path).isFile()) continue;
			const def = parseAgentFile(filename, readFileSync(path, "utf8"), source);
			if (def) out.push(def);
		} catch (err) {
			process.stderr.write(`[agents] could not parse ${path}: ${(err as Error).message}\n`);
		}
	}
	return out;
}

function parseAgentFile(filename: string, raw: string, source: "user" | "project"): SubagentDefinition | undefined {
	const name = filename.replace(/\.md$/, "").toLowerCase();
	if (!VALID_NAME.test(name)) {
		process.stderr.write(`[agents] skipping "${filename}": name must match ${VALID_NAME}.\n`);
		return undefined;
	}
	const { frontmatter, body } = parseMarkdownWithFrontmatter(raw);
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	return {
		name,
		description,
		source,
		tools: parseToolList(name, frontmatter.tools),
		prompt: body.trim() || undefined,
		model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
		effort: parseEffort(name, frontmatter.effort),
		maxTurns: parseMaxTurns(name, frontmatter.max_turns ?? frontmatter.maxTurns),
	};
}

function parseEffort(agent: string, value: unknown): Effort | undefined {
	if (value === undefined) return undefined;
	const effort = resolveEffort(String(value));
	if (!effort) process.stderr.write(`[agents] "${agent}": effort "${value}" is not a valid level — ignored.\n`);
	return effort;
}

function parseMaxTurns(agent: string, value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isInteger(n) || n < 1 || n > 50) {
		process.stderr.write(`[agents] "${agent}": max_turns "${value}" must be an integer 1–50 — ignored.\n`);
		return undefined;
	}
	return n;
}

function parseToolList(agent: string, value: string | readonly string[] | undefined): readonly string[] {
	if (value === undefined) return GENERAL_TOOLS;
	const requested = Array.isArray(value)
		? value
		: String(value)
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
	const allowed: string[] = [];
	for (const name of requested) {
		if (GENERAL_TOOLS.includes(name)) allowed.push(name);
		else process.stderr.write(`[agents] "${agent}": tool "${name}" isn't subagent-allowed — dropped.\n`);
	}
	return allowed.length > 0 ? allowed : EXPLORE_TOOLS;
}
