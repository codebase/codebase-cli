import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GlueClient } from "../glue/client.js";
import { microcompact } from "./microcompact.js";
import { contextWindow, estimateMessageTokens, estimateTotalTokens } from "./tokens.js";
import type { CompactionDetails, CompactionResult, MicrocompactResult } from "./types.js";

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_KEEP_RECENT = 8;
/** Newest compactable tool results microcompaction always keeps intact. */
const MICRO_KEEP_RECENT = 6;

const SUMMARY_SYSTEM_PROMPT = `Summarize the prior conversation between a user and a coding agent in tight markdown. Output structure:

## Progress
What concrete work has happened so far. File changes, decisions made.

## Context
Background or constraints introduced earlier that still matter.

## Current state
Where things stand right now. Pending work, error states, half-finished tasks.

## Next steps
What was queued or implied to come next, if anything.

Be concrete. Reference paths, function names, commit subjects when you have them. Skip pleasantries. Keep it under ~500 words.`;

export interface CompactionEngineOptions {
	glue: GlueClient;
	modelId: string;
	/**
	 * Authoritative context-window size from the resolved model. When set,
	 * this is used verbatim and the modelId-based regex fallback is
	 * bypassed entirely. Codebase Auto + proxy-synthesized models need
	 * this — their IDs (e.g. "MiniMax-M2.7") don't match any built-in
	 * regex and would otherwise fall back to 128k, triggering compaction
	 * at ~96k against a model that has 200k of headroom.
	 */
	contextWindow?: number;
	thresholdRatio?: number;
	keepRecent?: number;
}

export class CompactionEngine {
	private readonly glue: GlueClient;
	private readonly modelId: string;
	private readonly explicitContextWindow: number | undefined;
	private readonly thresholdRatio: number;
	private readonly keepRecent: number;

	constructor(options: CompactionEngineOptions) {
		this.glue = options.glue;
		this.modelId = options.modelId;
		this.explicitContextWindow = options.contextWindow;
		this.thresholdRatio = options.thresholdRatio ?? DEFAULT_THRESHOLD;
		this.keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
	}

	threshold(): number {
		const window = this.explicitContextWindow ?? contextWindow(this.modelId);
		return Math.floor(window * this.thresholdRatio);
	}

	needsCompaction(messages: AgentMessage[]): boolean {
		return estimateTotalTokens(messages) >= this.threshold();
	}

	/**
	 * Cheap first-pass compaction: clear the content of stale tool
	 * results (old file reads, grep dumps, command output the model
	 * already consumed) while keeping the newest few and preserving
	 * message structure. No glue-model round-trip. Returns the rewritten
	 * messages plus how much was freed.
	 *
	 * Exposed so the agent's transformContext can try this before the
	 * expensive summarize-everything path — clearing tool results often
	 * relieves the pressure on its own.
	 */
	microcompact(messages: AgentMessage[]): MicrocompactResult {
		return microcompact(messages, MICRO_KEEP_RECENT);
	}

	async compact(messages: AgentMessage[], signal?: AbortSignal): Promise<CompactionResult> {
		if (messages.length <= this.keepRecent) {
			return {
				messages,
				details: { readFiles: [], modifiedFiles: [], summary: "", truncatedTokens: 0, collapsedMessageCount: 0 },
			};
		}

		const splitIdx = findSafeSplit(messages, messages.length - this.keepRecent);
		if (splitIdx <= 0) {
			return {
				messages,
				details: { readFiles: [], modifiedFiles: [], summary: "", truncatedTokens: 0, collapsedMessageCount: 0 },
			};
		}

		const older = messages.slice(0, splitIdx);
		const recent = messages.slice(splitIdx);
		const truncatedTokens = older.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

		const details = extractFileOps(older);
		details.truncatedTokens = truncatedTokens;
		details.collapsedMessageCount = older.length;

		details.summary = await this.summarize(older, signal);

		const summaryMessage: AgentMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `[Conversation compacted — summary of previous work follows]\n\n${details.summary}\n\nFiles read earlier: ${
						details.readFiles.join(", ") || "(none)"
					}\nFiles modified earlier: ${details.modifiedFiles.join(", ") || "(none)"}`,
				},
			],
			timestamp: Date.now(),
		};
		const ackMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Got it — I have the context summary. Continuing from there." }],
			api: "compaction",
			provider: "compaction",
			model: this.modelId,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		return { messages: [summaryMessage, ackMessage, ...recent], details };
	}

	private async summarize(older: AgentMessage[], signal?: AbortSignal): Promise<string> {
		const transcript = older.map(serializeForSummary).join("\n\n");
		try {
			const out = await this.glue.smart(transcript, SUMMARY_SYSTEM_PROMPT, signal);
			return out.trim();
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return `(summarization failed: ${reason}; transcript truncated without a summary)`;
		}
	}
}

/**
 * Walk backwards from `desired` to find a split point where the tail of
 * `older` is a "boundary" — a user message or an assistant message with
 * no tool calls. Splitting between an assistant-with-toolCalls and its
 * toolResults would orphan the results in `recent` (their parent call
 * is summarized away), which providers reject.
 */
export function findSafeSplit(messages: AgentMessage[], desired: number): number {
	let idx = Math.min(Math.max(desired, 0), messages.length);
	while (idx > 0) {
		const prev = messages[idx - 1];
		if (prev.role === "user") return idx;
		if (prev.role === "assistant" && !messageHasToolCalls(prev)) return idx;
		idx--;
	}
	return 0;
}

function messageHasToolCalls(message: AgentMessage): boolean {
	if (!Array.isArray(message.content)) return false;
	return (message.content as Array<{ type: string }>).some((block) => block.type === "toolCall");
}

/**
 * Walk the truncated messages and extract the file paths the agent
 * touched. Mirrors pi-mono's CompactionDetails so the post-summary
 * model still has structured access to "what files mattered earlier".
 */
export function extractFileOps(messages: AgentMessage[]): CompactionDetails {
	const reads = new Set<string>();
	const writes = new Set<string>();
	const writeTools = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);
	const readTools = new Set(["read_file"]);

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall") continue;
			const name = block.name ?? "";
			const path = (block.arguments as { path?: string } | undefined)?.path;
			if (typeof path !== "string") continue;
			if (writeTools.has(name)) writes.add(path);
			else if (readTools.has(name)) reads.add(path);
		}
	}

	return {
		readFiles: Array.from(reads).sort(),
		modifiedFiles: Array.from(writes).sort(),
		summary: "",
		truncatedTokens: 0,
		collapsedMessageCount: 0,
	};
}

function serializeForSummary(message: AgentMessage): string {
	const role = message.role;
	if (role === "user") {
		const text = typeof message.content === "string" ? message.content : extractText(message.content);
		return `USER: ${text}`;
	}
	if (role === "assistant") {
		const parts: string[] = [];
		if (Array.isArray(message.content)) {
			for (const block of message.content as Array<{
				type: string;
				text?: string;
				name?: string;
				arguments?: unknown;
			}>) {
				if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
				else if (block.type === "toolCall") parts.push(`${block.name ?? "?"}(${shortArgs(block.arguments)})`);
			}
		}
		return `ASSISTANT: ${parts.join("\n")}`;
	}
	if (role === "toolResult") {
		const text = typeof message.content === "string" ? message.content : extractText(message.content);
		const toolName = (message as { toolName?: string }).toolName ?? "tool";
		return `[TOOL RESULT] ${toolName}: ${truncate(text, 500)}`;
	}
	return "";
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type: string; text?: string }>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}

function shortArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
	return entries
		.map(([k, v]) => {
			const s = typeof v === "string" ? `"${truncate(v, 30)}"` : JSON.stringify(v);
			return `${k}=${s}`;
		})
		.join(", ");
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
