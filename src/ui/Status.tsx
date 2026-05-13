import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../types.js";
import { Throbber } from "./Throbber.js";

/** Average chars-per-token across the major model families. Used only as a
 * fallback when the provider doesn't return usage info on message_end. */
const CHARS_PER_TOKEN = 4;

interface StatusProps {
	state: ChatState;
	cwd?: string;
	/** Context window in tokens; used to render the % used. */
	contextWindow?: number;
}

/**
 * Playful verbs we cycle through while the agent is thinking. They all
 * read as "the model is working." Kept ASCII-clean so they line up in
 * any terminal font.
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
 * Bottom status line — spinner + state on the left, model + cwd +
 * context % + cost on the right. Stays on one row in normal terminal
 * widths; the cwd basename is the only dynamic-length piece so we
 * always show what matters.
 */
export function Status({ state, cwd, contextWindow = 200_000 }: StatusProps) {
	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";
	const verb = useThinkingVerb(state.status === "thinking");
	let label = state.status === "thinking" ? verb : STATUS_LABEL[state.status];
	if (state.status === "tool") {
		const running = findRunningTool(state);
		if (running) label = `${STATUS_LABEL.tool} · ${running}`;
	}
	const color = STATUS_COLOR[state.status];
	const tokRate = useTokenRate(state);
	const elapsedSec = useBusyElapsed(busy);
	const u = state.usage;
	const usedTokens = estimateContextTokens(state);
	const ctxPct = contextWindow > 0 ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;
	const cwdLabel = cwd ? basename(cwd) || "/" : "";
	const modelLabel = state.model.name || state.model.id;

	return (
		<Box flexDirection="column">
			{state.error ? <ErrorCard message={state.error} /> : null}
			{ctxPct >= 85 ? <ContextWarning pct={ctxPct} /> : null}
			<Box paddingX={1} justifyContent="space-between">
				<Box>
					{busy ? (
						<>
							<Throbber color={color} />
							<Text> </Text>
						</>
					) : null}
					<Text color={color}>{label}</Text>
					{elapsedSec !== undefined ? <Text dimColor> ({elapsedSec}s)</Text> : null}
				</Box>
				<Box>
					<Text dimColor>
						{modelLabel}
						{cwdLabel ? ` · ${cwdLabel}` : ""} ·{" "}
					</Text>
					<Text color={ctxColor(ctxPct)}>
						{ctxBar(ctxPct)} {ctxPct}%
					</Text>
					<Text dimColor>
						{tokRate !== undefined ? ` · ${tokRate} tok/s` : ""} · ${formatCost(u.cost.total)}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

/**
 * Track how long the agent has been busy. Returns undefined unless the
 * elapsed time has crossed 3 seconds — short turns shouldn't carry an
 * "(0s)" suffix on the status bar. Resets cleanly when the agent
 * goes idle so consecutive turns each start their own timer.
 */
function useBusyElapsed(busy: boolean): number | undefined {
	const startRef = useRef<number | undefined>(undefined);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!busy) {
			startRef.current = undefined;
			return;
		}
		startRef.current = Date.now();
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, [busy]);
	if (!busy || !startRef.current) return undefined;
	const elapsed = Math.floor((Date.now() - startRef.current) / 1000);
	void tick;
	return elapsed >= 3 ? elapsed : undefined;
}

/**
 * Pluck the most-recently-started in-flight tool so the status bar can
 * say "Working · shell" instead of just "Working". Falls back to no
 * tool name when the map is empty — keeps the bar terse.
 */
function findRunningTool(state: ChatState): string | undefined {
	let best: { name: string; startedAt: number } | undefined;
	for (const tool of state.tools.values()) {
		if (tool.status !== "running") continue;
		if (!best || tool.startedAt > best.startedAt) {
			best = { name: tool.name, startedAt: tool.startedAt };
		}
	}
	return best?.name;
}

/**
 * Estimate the live token-output rate during streaming using a 4-second
 * sliding window over recent character growth. This avoids dragging the
 * rate down with the pre-text wait period — a thinking-heavy model that
 * spent 60s reasoning before emitting its first token should show "120
 * tok/s" once it starts streaming, not "5 tok/s averaged with the wait."
 *
 * Returns undefined when not streaming, or when the window doesn't yet
 * have enough samples / delta for the rate to be meaningful (so the bar
 * doesn't flicker noisy values in the first half-second).
 */
function useTokenRate(state: ChatState): number | undefined {
	const samplesRef = useRef<Array<{ t: number; c: number }>>([]);
	const charsRef = useRef(0);
	const [, setTick] = useState(0);
	const streaming = state.status === "streaming";

	// Keep the latest char count in a ref so the interval callback always
	// reads the live value rather than the closure-captured one.
	charsRef.current = streaming ? streamingChars(state) : 0;

	useEffect(() => {
		if (!streaming) {
			samplesRef.current = [];
			return;
		}
		const sample = () => {
			const now = Date.now();
			samplesRef.current.push({ t: now, c: charsRef.current });
			const cutoff = now - 4000;
			while (samplesRef.current.length > 0 && samplesRef.current[0].t < cutoff) {
				samplesRef.current.shift();
			}
			setTick((n) => n + 1);
		};
		sample(); // seed immediately
		const id = setInterval(sample, 500);
		return () => clearInterval(id);
	}, [streaming]);

	if (!streaming || samplesRef.current.length < 2) return undefined;
	const oldest = samplesRef.current[0];
	const newest = samplesRef.current[samplesRef.current.length - 1];
	const dt = (newest.t - oldest.t) / 1000;
	if (dt < 0.5) return undefined;
	const dc = newest.c - oldest.c;
	if (dc < 10) return undefined;
	return Math.round(dc / CHARS_PER_TOKEN / dt);
}

/**
 * Tokens currently in the model's context, for the status-bar fill meter.
 * Prefers the last-turn's reported `input + cacheRead` from pi-ai, since
 * that's literally what the model saw. Falls back to char-based estimation
 * when the provider strips usage (e.g. some OAuth-fronted proxies) so the
 * bar still grows as the conversation grows. Streaming content is added
 * on top of the prior-turn baseline so the bar visibly fills during a turn
 * instead of jumping at message_end.
 */
export function estimateContextTokens(state: ChatState): number {
	if (state.turnUsage && state.turnUsage.input + state.turnUsage.cacheRead > 0) {
		const reported = state.turnUsage.input + state.turnUsage.cacheRead;
		const streamingExtra = Math.round(streamingChars(state) / CHARS_PER_TOKEN);
		return reported + streamingExtra;
	}
	let chars = 0;
	for (const msg of state.messages) chars += messageChars(msg);
	if (state.streaming) chars += messageChars(state.streaming);
	return Math.round(chars / CHARS_PER_TOKEN);
}

function messageChars(message: AgentMessage): number {
	if (typeof message.content === "string") return message.content.length;
	if (!Array.isArray(message.content)) return 0;
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") total += block.text.length;
		else if (block.type === "thinking") total += block.thinking.length;
		else if (block.type === "toolCall") {
			total += block.name.length;
			total += JSON.stringify(block.arguments ?? {}).length;
		}
	}
	return total;
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

/**
 * Banner shown when the context window is past 85%. Suggests /compact
 * so the user can take action before auto-compaction kicks in, and
 * shifts to red past 95% where the next turn might actually trip the
 * model's hard limit.
 */
function ContextWarning({ pct }: { pct: number }) {
	const urgent = pct >= 95;
	return (
		<Box paddingX={1}>
			<Text color={urgent ? "red" : "yellow"} bold>
				{urgent ? "⚠" : "•"} {pct}% of context used
			</Text>
			<Text dimColor> — run /compact to free space</Text>
		</Box>
	);
}

/**
 * Boxed error card. Headers the error with ERROR + a one-line summary,
 * then shows the rest of the message body (if multi-line) in dim text.
 * Fatal errors need visual weight so the user doesn't miss them in a
 * busy transcript.
 */
function ErrorCard({ message }: { message: string }) {
	const lines = message.split("\n");
	const head = lines[0] ?? message;
	const body = lines.slice(1).filter((l) => l.trim().length > 0);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginY={0}>
			<Box>
				<Text color="red" bold>
					ERROR
				</Text>
				<Text> </Text>
				<Text>{head}</Text>
			</Box>
			{body.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{body.map((line, i) => (
						<Text key={`err-${i}-${line.slice(0, 12)}`} dimColor>
							{line}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	);
}

/**
 * Render a tiny 6-cell bar for the context-window meter. Eighth-block
 * glyphs give us 48 effective steps in 6 chars — enough resolution
 * that 12% / 25% / 50% all look visibly different. Empty cells stay
 * as a dim track so the bar always reads as a meter, not a slider.
 */
function ctxBar(pct: number): string {
	const cells = 6;
	const totalEighths = Math.round((pct / 100) * cells * 8);
	const full = Math.floor(totalEighths / 8);
	const remainder = totalEighths - full * 8;
	const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
	let out = "█".repeat(Math.min(full, cells));
	if (full < cells && remainder > 0) out += partials[remainder] ?? "";
	while (out.length < cells) out += "░";
	return out;
}

function ctxColor(pct: number): string {
	if (pct >= 90) return "red";
	if (pct >= 75) return "yellow";
	return "gray";
}

function formatCost(value: number): string {
	if (value === 0) return "0.0000";
	if (value < 0.01) return value.toFixed(4);
	return value.toFixed(2);
}
