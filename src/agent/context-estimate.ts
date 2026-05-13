import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatState } from "../types.js";

/**
 * Pure helpers for context-window + tok/s estimation. Extracted from
 * the ink-era Status.tsx so the pi-tui status bar (no React) can read
 * the same numbers without pulling react+ink into the bundle. Both
 * surfaces import from here; behavior is unchanged from the prior
 * inline implementations.
 */

/** Average chars-per-token across the major model families. Fallback for providers that strip usage. */
export const CHARS_PER_TOKEN = 4;

/**
 * Approximate static-context tokens the model sees on every turn but
 * that aren't in state.messages: system prompt, MEMORY.md addendum,
 * tool-schema definitions. Seeds the bar so it reads 1-2% on fresh
 * sessions instead of a misleading 0%.
 */
export const STATIC_CONTEXT_TOKENS = 3000;

export function estimateContextTokens(state: ChatState): number {
	if (state.turnUsage && state.turnUsage.input + state.turnUsage.cacheRead > 0) {
		const reported = state.turnUsage.input + state.turnUsage.cacheRead;
		const streamingExtra = Math.round(streamingChars(state) / CHARS_PER_TOKEN);
		return reported + streamingExtra;
	}
	let chars = 0;
	for (const msg of state.messages) chars += messageChars(msg);
	if (state.streaming) chars += messageChars(state.streaming);
	return STATIC_CONTEXT_TOKENS + Math.round(chars / CHARS_PER_TOKEN);
}

export function messageChars(message: AgentMessage): number {
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

export function streamingChars(state: ChatState): number {
	const m = state.streaming;
	if (!m || m.role !== "assistant") return 0;
	let total = 0;
	for (const block of m.content) {
		if (block.type === "text") total += block.text.length;
		else if (block.type === "thinking") total += block.thinking.length;
	}
	return total;
}
