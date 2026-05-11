import { basename } from "node:path";
import { Box, Text } from "ink";
import type { ChatState } from "../types.js";
import { Throbber } from "./Throbber.js";

interface StatusProps {
	state: ChatState;
	cwd?: string;
	/** Context window in tokens; used to render the % used. */
	contextWindow?: number;
}

const STATUS_LABEL: Record<ChatState["status"], string> = {
	idle: "ready",
	thinking: "thinking",
	streaming: "responding",
	tool: "tool",
	aborted: "aborted",
	error: "error",
};

const STATUS_COLOR: Record<ChatState["status"], string> = {
	idle: "green",
	thinking: "yellow",
	streaming: "cyan",
	tool: "magenta",
	aborted: "red",
	error: "red",
};

/**
 * Bottom status line — matches Claude Code's pattern: spinner + state
 * on the left, model + cwd + context % + cost on the right. Stays on
 * one row in normal terminal widths; the cwd basename is the only
 * dynamic-length piece so we always show what matters.
 */
export function Status({ state, cwd, contextWindow = 200_000 }: StatusProps) {
	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";
	const label = STATUS_LABEL[state.status];
	const color = STATUS_COLOR[state.status];
	const u = state.usage;
	const usedTokens = u.input + u.cacheRead;
	const ctxPct = contextWindow > 0 ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;
	const cwdLabel = cwd ? basename(cwd) || "/" : "";
	const modelLabel = state.model.name || state.model.id;

	return (
		<Box flexDirection="column">
			{state.error ? (
				<Box paddingX={1}>
					<Text color="red">! {state.error}</Text>
				</Box>
			) : null}
			<Box paddingX={1} justifyContent="space-between">
				<Box>
					{busy ? (
						<>
							<Throbber color={color} />
							<Text> </Text>
						</>
					) : null}
					<Text color={color}>{label}</Text>
				</Box>
				<Box>
					<Text dimColor>
						{modelLabel}
						{cwdLabel ? ` · ${cwdLabel}` : ""} · {ctxPct}% ctx · ${formatCost(u.cost.total)}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function formatCost(value: number): string {
	if (value === 0) return "0.0000";
	if (value < 0.01) return value.toFixed(4);
	return value.toFixed(2);
}
