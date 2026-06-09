import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/suspicious/noExplicitAny: AgentTool is generic over its schema; the wrapper is schema-agnostic by design.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * Per-result character cap for what the MODEL sees. Beyond this, the
 * full text is written to disk and the in-context payload is replaced
 * with a head preview + the file path so the agent can re-read on
 * demand. This is a MODEL-level bound, not a display trim — a single
 * unbounded grep / read_file / web_fetch can otherwise consume the
 * whole context window and silently cost the user a fortune.
 *
 * 50K chars ≈ 12-15K tokens. Generous enough that normal results pass
 * through untouched; tight enough that a repo-wide grep dump can't
 * blow the window.
 */
const DEFAULT_MAX_RESULT_CHARS = 50_000;

/** First N chars kept inline as a preview when a result is spilled. */
const PREVIEW_CHARS = 2_000;

/** Tools whose output is already self-bounded — skip the wrapper to avoid double work. */
const SELF_CAPPED_TOOLS: ReadonlySet<string> = new Set([
	// shell already spills to a tempfile past its own VISIBLE_CAP_BYTES,
	// so its returned content is small by construction.
	"shell",
	"ssh_exec",
	// dispatch_agent returns a short synthesized summary, never raw output.
	"dispatch_agent",
]);

/**
 * Wrap a tool so any oversized text result is persisted to
 * `~/.codebase/tool-results/` and replaced in-context with a preview +
 * path. Image content passes through untouched. Tools in
 * SELF_CAPPED_TOOLS are returned unchanged.
 *
 * The wrapper is transparent: same name, schema, label, execution mode
 * — only `execute`'s return value is post-processed.
 */
// biome-ignore lint/suspicious/noExplicitAny: schema-agnostic decorator over the generic AgentTool.
export function capToolResult(tool: AgentTool<any>, maxChars = DEFAULT_MAX_RESULT_CHARS): AgentTool<any> {
	if (SELF_CAPPED_TOOLS.has(tool.name)) return tool;

	const originalExecute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = await originalExecute(toolCallId, params, signal, onUpdate);
			return capResult(result, tool.name, toolCallId, maxChars);
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: AgentToolResult details type varies per tool.
function capResult(result: AgentToolResult<any>, toolName: string, toolCallId: string, maxChars: number) {
	// Sum the text length across all text blocks. Images don't count
	// toward the char budget — they're handled by the provider's own
	// token accounting and we can't meaningfully truncate them anyway.
	let textTotal = 0;
	for (const block of result.content) {
		if (block.type === "text") textTotal += block.text.length;
	}
	if (textTotal <= maxChars) return result;

	// Serialize the full text (joining multiple text blocks with a
	// newline) to disk, then collapse the content down to one preview
	// block. Non-text blocks are preserved in order at the front.
	const fullText = result.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const path = spillToDisk(toolName, toolCallId, fullText);
	const preview = fullText.slice(0, PREVIEW_CHARS);
	const notice =
		`[Output too large for context: ${textTotal} chars. Full result saved to:\n  ${path}\n` +
		`Read that file (read_file) to see the rest. Preview (first ${PREVIEW_CHARS} chars):]\n\n${preview}`;

	const images = result.content.filter((b) => b.type !== "text");
	return {
		...result,
		content: [...images, { type: "text" as const, text: notice }],
	};
}

function spillToDisk(toolName: string, toolCallId: string, full: string): string {
	const dir = join(homedir(), ".codebase", "tool-results");
	mkdirSync(dir, { recursive: true });
	const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
	const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "result";
	const path = join(dir, `${safeTool}-${safeId}-${Date.now()}.txt`);
	writeFileSync(path, full, "utf8");
	return path;
}
