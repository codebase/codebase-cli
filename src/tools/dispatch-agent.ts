import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { EXPLORE_TOOLS, type SubagentDefinition } from "../subagents/definitions.js";
import { capToolResult } from "./cap-tool-result.js";
import { createEditFile } from "./edit-file.js";
import { FileStateCache } from "./file-state-cache.js";
import { createGitCommit } from "./git/commit.js";
import { createGitDiff } from "./git/diff.js";
import { runGit } from "./git/git-helpers.js";
import { createGitLog } from "./git/log.js";
import { createGitStatus } from "./git/status.js";
import { createGlob } from "./glob.js";
import { createGrep } from "./grep.js";
import { createListFiles } from "./list-files.js";
import { createMultiEdit } from "./multi-edit.js";
import { createNotebookEdit } from "./notebook-edit.js";
import { createReadFile } from "./read-file.js";
import { createShell } from "./shell.js";
import { createShellKill } from "./shell-kill.js";
import { createShellOutput } from "./shell-output.js";
import { createSshExec } from "./ssh-exec.js";
import { createGetTask, createListTasks } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";
import { withCheckpoint } from "./with-checkpoint.js";
import { createWriteFile } from "./write-file.js";

const Params = Type.Object({
	task: Type.String({
		minLength: 1,
		maxLength: 4000,
		description:
			"What you want the subagent to do. Be specific — the subagent gets a fixed budget, so vague tasks waste turns.",
	}),
	agent_type: Type.Optional(
		Type.String({
			description:
				'Which agent type to run. "explore" (read-only investigator, default), "general" (can edit files / run shell / commit), or a custom type from .codebase/agents/.',
		}),
	),
	isolation: Type.Optional(
		Type.Union([Type.Literal("worktree")], {
			description:
				"\"worktree\" runs the subagent in a fresh git worktree so its file edits can't collide with yours or other subagents'. Removed automatically if it ends unchanged; kept (and reported) if the subagent committed or left changes.",
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 50,
			description: "Cap on subagent turns. Default 25.",
		}),
	),
});

export type DispatchAgentParams = Static<typeof Params>;

export interface DispatchAgentDetails {
	task: string;
	agentType: string;
	turns: number;
	maxTurnsReached: boolean;
	toolsUsed: string[];
	usage: Usage;
	worktree?: { path: string; branch: string; kept: boolean };
}

const DEFAULT_MAX_TURNS = 25;

/** Every tool a subagent may be granted, by name. Definitions pick subsets. */
const SUBAGENT_TOOL_FACTORIES: Record<string, (ctx: ToolContext) => AgentTool<TSchema>> = {
	read_file: createReadFile,
	list_files: createListFiles,
	glob: createGlob,
	grep: createGrep,
	web_fetch: createWebFetch,
	web_search: createWebSearch,
	git_status: createGitStatus,
	git_diff: createGitDiff,
	git_log: createGitLog,
	list_tasks: createListTasks,
	get_task: createGetTask,
	edit_file: createEditFile,
	multi_edit: createMultiEdit,
	write_file: createWriteFile,
	notebook_edit: createNotebookEdit,
	shell: createShell,
	shell_output: createShellOutput,
	shell_kill: createShellKill,
	git_commit: createGitCommit,
	ssh_exec: createSshExec,
};

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FALLBACK_EXPLORE: SubagentDefinition = {
	name: "explore",
	description: "Read-only investigator.",
	source: "builtin",
	tools: EXPLORE_TOOLS,
};

export function createDispatchAgent(ctx: ToolContext): AgentTool<typeof Params, DispatchAgentDetails> {
	const types = ctx.subagentTypes ?? [FALLBACK_EXPLORE];
	return {
		name: "dispatch_agent",
		label: "Subagent",
		description: buildDescription(types),
		parameters: Params,
		// Parallel so the model can fan out multiple subagents in a single
		// turn. Each subagent is its own isolated Agent; write-capable ones
		// share the user's permission gate, and worktree isolation is
		// available when parallel writers would collide.
		executionMode: "parallel",
		execute: async (_toolCallId, params, parentSignal, onUpdate) => {
			const def = types.find((t) => t.name === (params.agent_type ?? "explore"));
			if (!def) {
				const known = types.map((t) => t.name).join(", ");
				throw new Error(`unknown agent_type "${params.agent_type}". Available: ${known}.`);
			}
			const maxTurns = params.max_turns ?? DEFAULT_MAX_TURNS;
			let turns = 0;
			let maxTurnsReached = false;
			const toolsUsed: string[] = [];
			let lastAssistantText = "";
			let usage = EMPTY_USAGE;
			let success = false;

			await ctx.hooks?.dispatch(
				"SubagentStart",
				{
					event: "SubagentStart",
					workingDir: ctx.cwd,
					subagentType: def.name,
					subagentPrompt: params.task,
				},
				parentSignal,
			);

			// Worktree isolation: the subagent gets its own checkout (and its
			// own read-state cache — file freshness is per-tree).
			let worktree: SubagentWorktree | undefined;
			let runCtx = ctx;
			if (params.isolation === "worktree") {
				worktree = await createSubagentWorktree(ctx.cwd, parentSignal);
				runCtx = { ...ctx, cwd: worktree.path, fileStateCache: new FileStateCache() };
			}

			const subagent = ctx.spawnSubagent({
				systemPrompt: subagentSystemPrompt(def, params.task, runCtx.cwd),
				tools: buildSubagentTools(runCtx, def),
			});

			const onParentAbort = () => subagent.abort();
			parentSignal?.addEventListener("abort", onParentAbort);

			const details = (): DispatchAgentDetails => ({
				task: params.task,
				agentType: def.name,
				turns,
				maxTurnsReached,
				toolsUsed,
				usage,
				worktree: worktree ? { path: worktree.path, branch: worktree.branch, kept: false } : undefined,
			});

			const unsubscribe = subagent.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					toolsUsed.push(event.toolName);
					onUpdate?.({
						content: [{ type: "text", text: `${def.name} → ${event.toolName}` }],
						details: details(),
					});
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const text = extractAssistantText(event.message);
					if (text) lastAssistantText = text;
					const eventUsage = (event.message as { usage?: Usage }).usage;
					if (eventUsage) usage = mergeUsage(usage, eventUsage);
				} else if (event.type === "turn_end") {
					turns++;
					if (turns >= maxTurns) {
						maxTurnsReached = true;
						subagent.abort();
					}
				}
			});

			let worktreeNote = "";
			try {
				await subagent.prompt(params.task);
				success = true;
			} catch (err) {
				if (parentSignal?.aborted) throw err;
				if (!lastAssistantText) {
					const reason = err instanceof Error ? err.message : String(err);
					throw new Error(`subagent failed: ${reason}`);
				}
				// Fall through with whatever text we collected.
			} finally {
				unsubscribe();
				parentSignal?.removeEventListener("abort", onParentAbort);
				if (worktree) {
					worktree.kept = await settleWorktree(ctx.cwd, worktree);
					worktreeNote = worktree.kept
						? `\n\n[subagent left changes in worktree ${worktree.path} (branch ${worktree.branch}) — review and merge or discard]`
						: "";
				}
				await ctx.hooks?.dispatch(
					"SubagentStop",
					{
						event: "SubagentStop",
						workingDir: ctx.cwd,
						subagentType: def.name,
						subagentSuccess: success,
					},
					parentSignal,
				);
			}

			const finalText = lastAssistantText || "(subagent completed without producing a summary)";
			const summary = maxTurnsReached
				? `${finalText}\n\n[subagent stopped at ${turns} turns; raise max_turns if more depth is needed]`
				: finalText;

			return {
				content: [{ type: "text", text: summary + worktreeNote }],
				details: {
					...details(),
					worktree: worktree ? { path: worktree.path, branch: worktree.branch, kept: worktree.kept } : undefined,
				},
			};
		},
	};
}

function buildDescription(types: readonly SubagentDefinition[]): string {
	const typeLines = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
	return `Spawn a subagent to work on a specific task without polluting the main conversation.

Agent types (pass agent_type):
${typeLines}

When to use:
- "Find every place we call X and summarize the call patterns." (explore)
- "Fix the lint errors in these 12 files." (general — it can edit and run shell)
- Fan out several subagents in ONE turn for independent work streams; add isolation: "worktree" when parallel general agents would edit the same checkout.

Behavior:
- Default budget is 25 turns; raise via max_turns up to 50.
- Returns the subagent's final text answer; its tool calls happen invisibly but go through the same permission prompts as yours.
- Write-capable subagents' file edits are checkpointed (/rewind covers them).
- Aborts cleanly if the parent agent is aborted.

Don't use for trivial single-shot reads — call read_file directly. Subagents cannot spawn further subagents or ask the user questions.`;
}

function buildSubagentTools(ctx: ToolContext, def: SubagentDefinition): AgentTool<TSchema>[] {
	const tools: AgentTool<TSchema>[] = [];
	for (const name of def.tools) {
		const factory = SUBAGENT_TOOL_FACTORIES[name];
		if (!factory) continue;
		tools.push(capToolResult(withCheckpoint(factory(ctx), ctx)));
	}
	return tools;
}

function subagentSystemPrompt(def: SubagentDefinition, task: string, cwd: string): string {
	const lines = [
		`You are a focused ${def.name} subagent for codebase, a CLI coding agent. You complete one specific task and report back.`,
		"",
		`Tools: ${def.tools.join(", ")}.`,
		"You CANNOT spawn further subagents or ask the user questions. Don't try.",
	];
	if (def.prompt) {
		lines.push("", "# Role", "", def.prompt);
	}
	lines.push(
		"",
		"Approach:",
		"- Work efficiently. Cite file:line when answering questions about code.",
		"- Verify your changes (run the relevant test/build) before reporting them done.",
		"- Stop when the task is complete. Don't keep exploring tangents.",
		"- Your final assistant message is what gets returned. Make it self-contained.",
		"",
		`Working directory: ${cwd}`,
		"",
		"Task:",
		task,
	);
	return lines.join("\n");
}

interface SubagentWorktree {
	name: string;
	path: string;
	branch: string;
	baseSha: string;
	kept: boolean;
}

async function createSubagentWorktree(cwd: string, signal?: AbortSignal): Promise<SubagentWorktree> {
	const rootRes = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	if (rootRes.exitCode !== 0) {
		throw new Error('isolation: "worktree" requires a git repository.');
	}
	const root = rootRes.stdout.trim();
	const base = await runGit(["rev-parse", "HEAD"], root, signal);
	if (base.exitCode !== 0) {
		throw new Error("worktree isolation needs at least one commit (git rev-parse HEAD failed).");
	}
	const name = `sub-${randomBytes(4).toString("hex")}`;
	const path = join(root, ".worktrees", name);
	const branch = `subagent/${name}`;
	const add = await runGit(["worktree", "add", "-b", branch, path], root, signal);
	if (add.exitCode !== 0) {
		throw new Error(add.stderr.trim() || `git worktree add exited ${add.exitCode}`);
	}
	return { name, path, branch, baseSha: base.stdout.trim(), kept: false };
}

/** Remove the worktree if the subagent left it pristine. Returns true when kept. */
async function settleWorktree(cwd: string, worktree: SubagentWorktree): Promise<boolean> {
	try {
		const status = await runGit(["status", "--porcelain"], worktree.path);
		const head = await runGit(["rev-parse", "HEAD"], worktree.path);
		const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0;
		const committed = head.exitCode !== 0 || head.stdout.trim() !== worktree.baseSha;
		if (dirty || committed) return true;
		await runGit(["worktree", "remove", worktree.path], cwd);
		await runGit(["branch", "-D", worktree.branch], cwd);
		return false;
	} catch {
		return true;
	}
}

function extractAssistantText(message: { content?: { type: string; text?: string }[] } | unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: { type: string; text?: string }[] }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
}

function mergeUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}
