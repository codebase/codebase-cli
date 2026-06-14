import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildContestantTools } from "../tools/dispatch-agent.js";
import { FileStateCache } from "../tools/file-state-cache.js";
import type { ToolContext } from "../tools/types.js";
import type { ContestantRunner } from "./tournament.js";

/**
 * Builds the /tournament contestant runner from the live tool context.
 * Each contestant is a general agent rooted at its worktree, with a fresh
 * file-state cache and no checkpoint store (its edits live in a throwaway
 * worktree, so the main /rewind log shouldn't see them). It runs to
 * completion under a turn cap and returns its final report.
 */
export function createContestantRunner(
	toolContext: ToolContext,
	contestantPrompt: (task: string, cwd: string) => string,
	maxTurns = 30,
): ContestantRunner {
	return async ({ worktreePath, task, model, signal, onToolCall }) => {
		const wtCtx: ToolContext = {
			...toolContext,
			cwd: worktreePath,
			fileStateCache: new FileStateCache(),
			checkpoints: undefined,
		};
		const agent = toolContext.spawnSubagent({
			systemPrompt: contestantPrompt(task, worktreePath),
			tools: buildContestantTools(wtCtx),
			model,
		});

		let lastText = "";
		let turns = 0;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				onToolCall?.(event.toolName);
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const text = assistantText(event.message);
				if (text) lastText = text;
			} else if (event.type === "turn_end") {
				turns++;
				if (turns >= maxTurns) agent.abort();
			}
		});

		const onParentAbort = () => agent.abort();
		signal?.addEventListener("abort", onParentAbort);
		try {
			await agent.prompt(task);
		} catch (err) {
			if (signal?.aborted) throw err;
			// Keep whatever the contestant produced before dying.
			if (!lastText) throw err;
		} finally {
			unsubscribe();
			signal?.removeEventListener("abort", onParentAbort);
		}
		return { summary: lastText || "(no summary)" };
	};
}

/** System prompt for a tournament contestant — implement fully, verify, report. */
export function defaultContestantPrompt(task: string, cwd: string): string {
	return [
		"You are one contestant in a coding tournament: several agents independently attempt the SAME task, and a judge picks the best result. Win by producing the most correct, complete, and minimal change.",
		"",
		"Rules:",
		"- Implement the task fully in this working directory. Don't leave it half-done.",
		"- Verify your work — run the project's tests/build/lint where it makes sense.",
		"- Prefer a focused diff over a sprawling one; don't touch unrelated code.",
		"- You CANNOT ask the user questions. Make reasonable assumptions and note them.",
		"- Your final message is your pitch to the judge: say what you did and why it's correct. Keep it tight.",
		"",
		`Working directory: ${cwd}`,
		"",
		"Task:",
		task,
	].join("\n");
}

function assistantText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
			.map((b) => b.text)
			.join("");
	}
	return "";
}
