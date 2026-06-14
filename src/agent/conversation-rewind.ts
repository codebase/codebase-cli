import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Conversation rewind: roll the transcript back to just before a prior
 * user prompt. Each genuine user prompt is a rewind point; selecting one
 * drops it and everything after, so the conversation returns to the
 * moment before that message was sent. Pairs with the file checkpoint
 * store so the working tree can be restored to the same point.
 */

export interface RewindPoint {
	/** Index into the message array — truncation keeps messages[0..index). */
	index: number;
	/** First line of the prompt, cleaned and clipped, for the picker. */
	preview: string;
	/** The prompt's timestamp; used to find the matching file checkpoint. */
	timestamp: number;
}

/** Every user prompt in the transcript, chronological. Tool-result and empty messages are skipped. */
export function listRewindPoints(messages: readonly AgentMessage[]): RewindPoint[] {
	const points: RewindPoint[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const text = cleanPromptText(m);
		if (!text) continue;
		points.push({ index: i, preview: clip(text, 80), timestamp: m.timestamp ?? 0 });
	}
	return points;
}

/** Messages up to (not including) the rewind point — the new transcript after a rewind. */
export function truncateBefore(messages: readonly AgentMessage[], index: number): AgentMessage[] {
	return messages.slice(0, index);
}

/** Extract a user message's prompt text, dropping injected reminders and non-text blocks. */
function cleanPromptText(m: AgentMessage): string {
	let raw: string;
	if (typeof m.content === "string") {
		raw = m.content;
	} else if (Array.isArray(m.content)) {
		raw = m.content
			.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
			.map((b) => b.text)
			.join(" ");
	} else {
		raw = "";
	}
	return raw
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
