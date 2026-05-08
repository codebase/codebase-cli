import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 3.8;
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Rough token estimate from message length. Used to decide whether to
 * compact. We deliberately don't reach for a real tokenizer here:
 *   - Real tokenizers are slow on every turn.
 *   - The agent doesn't need exact counts to make a binary trigger
 *     decision; the 75% threshold has plenty of slack.
 *
 * Assistant messages emitted by pi-agent-core carry a `usage` block
 * with the provider-reported `totalTokens`. When that's present we
 * trust it over the chars/3.8 heuristic — this gives accurate
 * accounting on assistant turns and keeps the heuristic only for the
 * user/tool messages we have no real token count for.
 */
export function estimateMessageTokens(message: AgentMessage): number {
	const usage = (message as { usage?: Usage }).usage;
	if (usage && typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
		return usage.totalTokens;
	}
	const body = serialize(message);
	return Math.ceil(body.length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
}

export function estimateTotalTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) total += estimateMessageTokens(m);
	return total;
}

/**
 * Best-effort context-window lookup. Map covers the common cases used
 * by the v2 cli; unknown models fall back to 128K which matches the
 * majority of currently shipping APIs.
 */
const CONTEXT_WINDOWS: Array<{ match: RegExp; window: number }> = [
	{ match: /^claude-(opus|sonnet)-4/, window: 200_000 },
	{ match: /^claude-(opus|sonnet)-3/, window: 200_000 },
	{ match: /^claude-haiku-4/, window: 200_000 },
	{ match: /^claude-haiku-3-5/, window: 200_000 },
	{ match: /^gpt-5/, window: 400_000 },
	{ match: /^gpt-4o/, window: 128_000 },
	{ match: /^gpt-4-turbo/, window: 128_000 },
	{ match: /^o3/, window: 200_000 },
	{ match: /^o4/, window: 200_000 },
	{ match: /^gemini-2/, window: 1_000_000 },
	{ match: /^llama-3-3-70b/, window: 128_000 },
	{ match: /^mistral-large/, window: 131_000 },
];

export function contextWindow(modelId: string): number {
	const id = modelId.toLowerCase();
	for (const entry of CONTEXT_WINDOWS) {
		if (entry.match.test(id)) return entry.window;
	}
	return 128_000;
}

function serialize(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content as Array<{
		type: string;
		text?: string;
		thinking?: string;
		arguments?: unknown;
	}>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
		else if (block.type === "toolCall" && block.arguments !== undefined) {
			try {
				parts.push(JSON.stringify(block.arguments));
			} catch {
				/* skip un-serializable */
			}
		}
	}
	return parts.join("\n");
}
