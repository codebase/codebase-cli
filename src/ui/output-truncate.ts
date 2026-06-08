/**
 * Per-tool display caps for inline tool output. Search-style tools
 * (grep, find, glob) produce many matches, most of which the user
 * doesn't need to read inline — the model still sees the full result.
 *
 * Shared between the ink path (`TruncatedOutput`) and the pi-tui path
 * (`renderTruncatedOutput`) so both render the same limits.
 */
export const DEFAULT_MAX_TOOL_OUTPUT_LINES = 12;

export const TOOL_OUTPUT_LIMITS: Record<string, number> = {
	grep: 6,
	search_files: 6,
	glob: 8,
	find: 8,
	list_files: 10,
};

export interface TruncatedView {
	truncated: false;
	full: string;
}

export interface TruncatedSplit {
	truncated: true;
	head: string;
	tail: string;
	hidden: number;
}

export type TruncatedOutputView = TruncatedView | TruncatedSplit;

/**
 * Decide whether to render the full text or split it into a head + tail
 * with a hidden-line summary in between. `isError` forces full output —
 * a failing tool's full payload is exactly what the user needs to debug.
 */
export function truncateOutput(text: string, toolName: string | undefined, isError: boolean): TruncatedOutputView {
	const max =
		toolName && TOOL_OUTPUT_LIMITS[toolName] !== undefined
			? TOOL_OUTPUT_LIMITS[toolName]
			: DEFAULT_MAX_TOOL_OUTPUT_LINES;
	const lines = text.split("\n");
	if (isError || lines.length <= max) {
		return { truncated: false, full: text };
	}
	// Reserve at least 1 head + 1 tail line so the user can see the
	// shape of the truncation; rest is head-weighted (where the
	// interesting content usually is).
	const tailLines = max >= 8 ? 3 : 2;
	const headLines = Math.max(1, max - tailLines - 1);
	const head = lines.slice(0, headLines).join("\n");
	const tail = lines.slice(lines.length - tailLines).join("\n");
	const hidden = lines.length - headLines - tailLines;
	return { truncated: true, head, tail, hidden };
}
