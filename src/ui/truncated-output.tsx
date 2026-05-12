import { Text } from "ink";
import { WrappedLines } from "./wrapped-lines.js";

const DEFAULT_MAX_TOOL_OUTPUT_LINES = 12;

/**
 * Per-tool display caps. Search-style tools (grep, find, glob) produce
 * many matches, most of which the user doesn't need to read inline —
 * the model still sees the full result. Default is 12 lines.
 */
export const TOOL_OUTPUT_LIMITS: Record<string, number> = {
	grep: 6,
	search_files: 6,
	glob: 8,
	find: 8,
	list_files: 10,
};

/**
 * Truncate tool output past the per-tool limit into "head + (N hidden)
 * + tail" — long shell or grep output otherwise dominates the
 * transcript and pushes context off-screen. The agent still gets the
 * full output; this is purely a display trim. Errors are NEVER
 * truncated since the user needs to see exactly what blew up.
 */
export function TruncatedOutput({
	text,
	width,
	keyPrefix,
	color,
	toolName,
}: {
	text: string;
	width: number;
	keyPrefix: string;
	color?: string;
	toolName?: string;
}) {
	const max =
		toolName && TOOL_OUTPUT_LIMITS[toolName] !== undefined
			? TOOL_OUTPUT_LIMITS[toolName]
			: DEFAULT_MAX_TOOL_OUTPUT_LINES;
	// Reserve at least 1 head + 1 tail line so the user can see the
	// shape of the truncation; rest is head-weighted (where the
	// interesting content usually is).
	const tailLines = max >= 8 ? 3 : 2;
	const headLines = Math.max(1, max - tailLines - 1);
	const lines = text.split("\n");
	if (color === "red" || lines.length <= max) {
		return <WrappedLines text={text} width={width} keyPrefix={keyPrefix} color={color} />;
	}
	const head = lines.slice(0, headLines).join("\n");
	const tail = lines.slice(lines.length - tailLines).join("\n");
	const hidden = lines.length - headLines - tailLines;
	return (
		<>
			<WrappedLines text={head} width={width} keyPrefix={`${keyPrefix}-h`} color={color} />
			<Text dimColor>{`… ${hidden} line${hidden === 1 ? "" : "s"} hidden …`}</Text>
			<WrappedLines text={tail} width={width} keyPrefix={`${keyPrefix}-t`} color={color} />
		</>
	);
}
