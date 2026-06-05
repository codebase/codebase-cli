import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { createEditFile } from "./edit-file.js";
import { createGitDiff } from "./git/diff.js";
import { createGitLog } from "./git/log.js";
import { createGitStatus } from "./git/status.js";
import { createGlob } from "./glob.js";
import { createGrep } from "./grep.js";
import { createListFiles } from "./list-files.js";
import { createMultiEdit } from "./multi-edit.js";
import { createReadFile } from "./read-file.js";
import { createShell } from "./shell.js";
import { createGetTask, createListTasks } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";
import { createWriteFile } from "./write-file.js";

const Params = Type.Object({
	task: Type.String({
		minLength: 1,
		maxLength: 4000,
		description:
			"What you want the subagent to investigate. Be specific — the subagent gets read-only tools and a fixed budget, so vague tasks waste turns.",
	}),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 50,
			description: "Cap on subagent turns. Default 25.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("research"), Type.Literal("build")], {
			description:
				"research (default): read-only investigation. build: the worker can also write files and run shell commands — every action still passes the same permission gate as you, so it can't exceed your autonomy.",
		}),
	),
});

export type DispatchAgentParams = Static<typeof Params>;

export interface DispatchAgentDetails {
	task: string;
	turns: number;
	maxTurnsReached: boolean;
	toolsUsed: string[];
	usage: Usage;
}

const DEFAULT_MAX_TURNS = 25;

const DESCRIPTION = `Spawn a subagent (worker) to handle a scoped task without polluting the main conversation.

When to use:
- Research: "Find every place we call X and summarize the call patterns."
- Delegated work (mode "build"): "Implement the email-validation helper and its tests."
- Long-tail work where intermediate tool output isn't useful in the main transcript.

Behavior:
- mode "research" (default): read-only tools (read_file, list_files, glob, grep, web_search, web_fetch, git_status/diff/log, list_tasks, get_task).
- mode "build": adds write_file, edit_file, multi_edit, shell — the worker can change files and run commands. Every action passes the SAME permission gate as you, so a build worker can never do anything you couldn't.
- No recursion: a subagent can't spawn further subagents.
- Default budget is 25 turns; raise via max_turns up to 50. Returns the subagent's final text answer; tool calls happen invisibly. Aborts cleanly with the parent.

Don't use for a trivial single read or single edit — call that tool directly.`;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createDispatchAgent(ctx: ToolContext): AgentTool<typeof Params, DispatchAgentDetails> {
	return {
		name: "dispatch_agent",
		label: "Subagent",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_toolCallId, params, parentSignal, onUpdate) => {
			const maxTurns = params.max_turns ?? DEFAULT_MAX_TURNS;
			const mode = params.mode ?? "research";
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
					// dispatch_agent currently only ships a read-only subagent type;
					// when planAgent / generalAgent variants land we'll surface them.
					subagentType: "read-only",
					subagentPrompt: params.task,
				},
				parentSignal,
			);

			const subagent = ctx.spawnSubagent({
				systemPrompt: subagentSystemPrompt(params.task, ctx.cwd, mode),
				tools: buildSubagentTools(ctx, mode),
			});

			const onParentAbort = () => subagent.abort();
			parentSignal?.addEventListener("abort", onParentAbort);

			const unsubscribe = subagent.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					toolsUsed.push(event.toolName);
					onUpdate?.({
						content: [{ type: "text", text: `subagent → ${event.toolName}` }],
						details: { task: params.task, turns, maxTurnsReached, toolsUsed, usage },
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
				await ctx.hooks?.dispatch(
					"SubagentStop",
					{
						event: "SubagentStop",
						workingDir: ctx.cwd,
						subagentType: "read-only",
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
				content: [{ type: "text", text: summary }],
				details: { task: params.task, turns, maxTurnsReached, toolsUsed, usage },
			};
		},
	};
}

export function buildSubagentTools(ctx: ToolContext, mode: "research" | "build" = "research"): AgentTool<TSchema>[] {
	const tools: AgentTool<TSchema>[] = [
		createReadFile(ctx),
		createListFiles(ctx),
		createGlob(ctx),
		createGrep(ctx),
		createWebFetch(ctx),
		createWebSearch(ctx),
		createGitStatus(ctx),
		createGitDiff(ctx),
		createGitLog(ctx),
		createListTasks(ctx),
		createGetTask(ctx),
	];
	// build workers can act — but never spawn further subagents (no recursion).
	if (mode === "build") {
		tools.push(createWriteFile(ctx), createEditFile(ctx), createMultiEdit(ctx), createShell(ctx));
	}
	return tools;
}

function subagentSystemPrompt(task: string, cwd: string, mode: "research" | "build"): string {
	const capability =
		mode === "build"
			? "Tools: the read-only set PLUS write_file, edit_file, multi_edit, shell. You CAN change files and run commands — every action passes the same permission gate as your director, which blocks any irreversible op it hasn't authorized. You cannot spawn further subagents."
			: "Tools: read_file, list_files, glob, grep, web_search, web_fetch, git_status, git_diff, git_log, list_tasks, get_task. Read-only. You CANNOT write files, run shell commands, or spawn further subagents.";
	return [
		"You are a focused subagent for codebase, a CLI coding agent. You do one specific task and report back.",
		"",
		capability,
		"",
		"Approach:",
		"- Work efficiently. Cite file:line when answering questions about code.",
		"- Stop when the task is done. Don't chase tangents.",
		"- Your final assistant message is what gets returned. Make it self-contained.",
		"",
		`Working directory: ${cwd}`,
		"",
		"Task:",
		task,
	].join("\n");
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
