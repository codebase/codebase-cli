import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens } from "./tokens.js";
import type { MicrocompactResult } from "./types.js";

/**
 * Placeholder swapped in for a cleared tool result. Kept terse and
 * self-explanatory so the model understands the content is gone but
 * re-obtainable, without spending tokens describing it.
 */
export const CLEARED_TOOL_RESULT =
	"[Old tool result content cleared — re-read the file or re-run the command if you need it again]";

/**
 * Tool results worth clearing once they're stale: read-only lookups and
 * file/command output that the model has already acted on. Deliberately
 * EXCLUDES tools whose result is small or load-bearing past its turn
 * (ask_user, tasks, memory, config, git status/diff — those are short
 * and often re-referenced). Mirrors Claude Code's COMPACTABLE_TOOLS.
 */
const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"shell",
	"ssh_exec",
	"grep",
	"glob",
	"list_files",
	"web_fetch",
	"web_search",
	"edit_file",
	"multi_edit",
	"write_file",
]);

const DEFAULT_KEEP_RECENT = 6;

/**
 * Microcompaction: clear the CONTENT of stale tool-result messages while
 * keeping the message itself (so the tool_use/tool_result pairing stays
 * intact and the provider doesn't reject the transcript). The newest
 * `keepRecent` compactable results are left untouched — they're the
 * model's live working set.
 *
 * This is the cheap first line of defense against context pressure: a
 * repo-wide grep dump or a big file read the model already consumed gets
 * its bytes reclaimed WITHOUT a glue-model summary round-trip. The
 * expensive summarize-everything compaction stays as the fallback for
 * when clearing tool results alone isn't enough.
 *
 * Errored results are preserved — they're short and usually still
 * relevant as debugging signal. Already-cleared results are skipped so
 * the pass is idempotent.
 */
export function microcompact(messages: AgentMessage[], keepRecent = DEFAULT_KEEP_RECENT): MicrocompactResult {
	// First pass: index every compactable, not-yet-cleared tool-result
	// message in order.
	const indices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "toolResult") continue;
		const tr = m as ToolResultMessage;
		if (tr.isError) continue;
		if (!COMPACTABLE_TOOLS.has(tr.toolName)) continue;
		if (isAlreadyCleared(tr)) continue;
		indices.push(i);
	}

	// Keep the most-recent `keepRecent`; clear the rest.
	const keep = Math.max(0, keepRecent);
	const clearIdx = new Set(indices.slice(0, Math.max(0, indices.length - keep)));
	if (clearIdx.size === 0) {
		return { messages, tokensSaved: 0, clearedCount: 0 };
	}

	let tokensSaved = 0;
	const next = messages.map((m, i) => {
		if (!clearIdx.has(i)) return m;
		const tr = m as ToolResultMessage;
		const before = estimateMessageTokens(m);
		const cleared: ToolResultMessage = {
			...tr,
			content: [{ type: "text", text: CLEARED_TOOL_RESULT }],
		};
		tokensSaved += before - estimateMessageTokens(cleared as AgentMessage);
		return cleared as AgentMessage;
	});

	return { messages: next, tokensSaved: Math.max(0, tokensSaved), clearedCount: clearIdx.size };
}

interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
	timestamp: number;
}

function isAlreadyCleared(tr: ToolResultMessage): boolean {
	return tr.content.length === 1 && tr.content[0].type === "text" && tr.content[0].text === CLEARED_TOOL_RESULT;
}
