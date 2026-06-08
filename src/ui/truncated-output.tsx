import { Text } from "ink";
import { truncateOutput } from "./output-truncate.js";
import { WrappedLines } from "./wrapped-lines.js";

// Re-export the constants so existing callers keep working.
export { DEFAULT_MAX_TOOL_OUTPUT_LINES, TOOL_OUTPUT_LIMITS } from "./output-truncate.js";

/**
 * Truncate tool output past the per-tool limit into "head + (N hidden)
 * + tail" — long shell or grep output otherwise dominates the
 * transcript and pushes context off-screen. The agent still gets the
 * full output; this is purely a display trim. Errors are NEVER
 * truncated since the user needs to see exactly what blew up.
 *
 * Cap logic lives in `./output-truncate.ts` so the pi-tui path can
 * reuse it without dragging in React + ink.
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
	const view = truncateOutput(text, toolName, color === "red");
	if (!view.truncated) {
		return <WrappedLines text={view.full} width={width} keyPrefix={keyPrefix} color={color} />;
	}
	return (
		<>
			<WrappedLines text={view.head} width={width} keyPrefix={`${keyPrefix}-h`} color={color} />
			<Text dimColor>{`… ${view.hidden} line${view.hidden === 1 ? "" : "s"} hidden …`}</Text>
			<WrappedLines text={view.tail} width={width} keyPrefix={`${keyPrefix}-t`} color={color} />
		</>
	);
}
