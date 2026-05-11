import { basename } from "node:path";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../types.js";
import { Throbber } from "./Throbber.js";

interface StatusProps {
	state: ChatState;
	cwd?: string;
	/** Context window in tokens; used to render the % used. */
	contextWindow?: number;
}

/**
 * Playful verbs we cycle through while the agent is thinking — the
 * Claude Code signature. They all read as "the model is working".
 * Kept ASCII-clean so they line up in any terminal font.
 */
const THINKING_VERBS = [
	"Thinking",
	"Pondering",
	"Synthesizing",
	"Cogitating",
	"Ruminating",
	"Deliberating",
	"Mulling",
	"Marinating",
	"Brewing",
	"Contemplating",
	"Reasoning",
	"Considering",
];

const STATUS_LABEL: Record<ChatState["status"], string> = {
	idle: "ready",
	thinking: "Thinking",
	streaming: "Writing",
	tool: "Working",
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
	const verb = useThinkingVerb(state.status === "thinking");
	const label = state.status === "thinking" ? verb : STATUS_LABEL[state.status];
	const color = STATUS_COLOR[state.status];
	const tokRate = useTokenRate(state);
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
						{cwdLabel ? ` · ${cwdLabel}` : ""} · {ctxPct}% ctx
						{tokRate !== undefined ? ` · ${tokRate} tok/s` : ""} · ${formatCost(u.cost.total)}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

/**
 * Estimate the live token-output rate during streaming. Pi-ai only
 * surfaces accurate `usage` at message_end, so for the live counter
 * we approximate from the streaming message's character length using
 * the common ~4-chars-per-token rule. Cheap, no extra deps, and
 * accurate enough for a status-bar readout.
 *
 * Returns undefined when not streaming, or when too few chars have
 * accumulated for the rate to be meaningful (so the bar doesn't
 * flicker a noisy "9999 tok/s" in the first 100ms).
 */
function useTokenRate(state: ChatState): number | undefined {
	const startRef = useRef<number | undefined>(undefined);
	const [tick, setTick] = useState(0);
	const streaming = state.status === "streaming";
	useEffect(() => {
		if (!streaming) {
			startRef.current = undefined;
			return;
		}
		if (startRef.current === undefined) startRef.current = Date.now();
		const id = setInterval(() => setTick((t) => t + 1), 500);
		return () => clearInterval(id);
	}, [streaming]);
	if (!streaming || !startRef.current) return undefined;
	const elapsedSec = (Date.now() - startRef.current) / 1000;
	if (elapsedSec < 0.5) return undefined;
	void tick; // force re-eval on each interval
	const chars = streamingChars(state);
	if (chars < 40) return undefined;
	const tokens = chars / 4;
	const rate = tokens / elapsedSec;
	return Math.round(rate);
}

/** Sum the visible text length of all text/thinking blocks in the live streaming message. */
function streamingChars(state: ChatState): number {
	const m = state.streaming;
	if (!m || m.role !== "assistant") return 0;
	let total = 0;
	for (const block of m.content) {
		if (block.type === "text") total += block.text.length;
		else if (block.type === "thinking") total += block.thinking.length;
	}
	return total;
}

/**
 * While the agent is thinking, swap the verb every 3 seconds. We pick
 * the next verb at random (excluding the current one) instead of
 * cycling in order so the same word doesn't reappear at predictable
 * beats. When the status leaves thinking we drop back to the first
 * verb so re-entry starts fresh.
 */
function useThinkingVerb(active: boolean): string {
	const [verb, setVerb] = useState(THINKING_VERBS[0]);
	useEffect(() => {
		if (!active) {
			setVerb(THINKING_VERBS[0]);
			return;
		}
		const id = setInterval(() => {
			setVerb((current) => {
				let next = current;
				while (next === current) {
					next = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
				}
				return next;
			});
		}, 3000);
		return () => clearInterval(id);
	}, [active]);
	return verb;
}

function formatCost(value: number): string {
	if (value === 0) return "0.0000";
	if (value < 0.01) return value.toFixed(4);
	return value.toFixed(2);
}
