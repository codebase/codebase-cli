import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { createGitDiff } from "./git/diff.js";
import { createGitLog } from "./git/log.js";
import { createGitStatus } from "./git/status.js";
import { createGlob } from "./glob.js";
import { createGrep } from "./grep.js";
import { createListFiles } from "./list-files.js";
import { createReadFile } from "./read-file.js";
import { createGetTask, createListTasks } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";

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

const DESCRIPTION = `Spawn a read-only subagent to investigate a specific question without polluting the main conversation.

When to use:
- "Find every place we call X and summarize the call patterns."
- "Read these 8 files and tell me which one matches my mental model best."
- Long tail searches where the noise of intermediate tool output isn't useful in the main transcript.

Behavior:
- Subagent has only read tools: read_file, list_files, glob, grep, web_search, web_fetch, git_status/diff/log, list_tasks, get_task. No writes, no shell, no recursion.
- Default budget is 25 turns; raise via max_turns up to 50.
- Returns the subagent's final text answer; tool calls happen invisibly.
- Aborts cleanly if the parent agent is aborted.

Don't use for tasks that need to write files or run commands — call those tools directly. Don't use for trivial single-shot reads — call read_file directly.`;

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
			let turns = 0;
			let maxTurnsReached = false;
			const toolsUsed: string[] = [];
			let lastAssistantText = "";
			let usage = EMPTY_USAGE;

			const subagent = ctx.spawnSubagent({
				systemPrompt: subagentSystemPrompt(params.task, ctx.cwd),
				tools: buildSubagentTools(ctx),
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

function buildSubagentTools(ctx: ToolContext): AgentTool<TSchema>[] {
	return [
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
}

function subagentSystemPrompt(task: string, cwd: string): string {
	return [
		"You are a focused research subagent for codebase, a CLI coding agent. You investigate one specific question and report back.",
		"",
		"Tools: read_file, list_files, glob, grep, web_search, web_fetch, git_status, git_diff, git_log, list_tasks, get_task. Read-only.",
		"You CANNOT write files, run shell commands, or spawn further subagents. Don't try.",
		"",
		"Approach:",
		"- Investigate efficiently. Cite file:line when answering questions about code.",
		"- Stop when you've answered the task. Don't keep exploring tangents.",
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
