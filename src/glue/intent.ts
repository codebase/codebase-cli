import type { GlueClient } from "./client.js";

export type Intent = "agent" | "plan" | "chat" | "clarify";

const INTENT_SYSTEM_PROMPT = `You classify the user's message into ONE of these intents:

- agent: a coding/automation/build/fix request. Run-the-tools work. (Default for anything actionable.)
- plan: a complex multi-step ask that benefits from upfront planning before code is written ("add auth to my Next app", "rewrite the worker as a state machine").
- chat: small talk, gratitude, greetings, meta-questions about the agent itself.
- clarify: ambiguous request where the agent couldn't act productively without more info.

Output exactly one word: agent | plan | chat | clarify. No prose.`;

const GREETING_PATTERNS = [
	/^h(i|ello|ey)\b/i,
	/^howdy\b/i,
	/^thanks?\b/i,
	/^thank you\b/i,
	/^ty\b/i,
	/^ok\b/i,
	/^okay\b/i,
	/^nice\b/i,
	/^cool\b/i,
	/^great\b/i,
	/^good (morning|afternoon|evening|night)\b/i,
];

export interface ClassifyOptions {
	hasHistory: boolean;
	signal?: AbortSignal;
}

/**
 * Decide whether the user's message should run the main agent (tool
 * work), enter plan mode (Q&A → reviewable plan), be answered as chat
 * (no agent run), or trigger a clarifying question.
 *
 * Fast-tracks:
 *   - First message in a session: default to "agent" for anything
 *     non-trivial (history-less context biases toward action).
 *   - Continuations starting with greetings/thanks: short-circuit to
 *     "chat" without an LLM call.
 *
 * On LLM error or unparseable output, defaults to "agent" — failing
 * open is preferable to silently dropping a real request.
 */
export async function classifyIntent(glue: GlueClient, message: string, opts: ClassifyOptions): Promise<Intent> {
	const trimmed = message.trim();
	if (!trimmed) return "clarify";

	if (opts.hasHistory && isGreeting(trimmed)) {
		return "chat";
	}

	let raw: string;
	try {
		raw = await glue.fast(trimmed, INTENT_SYSTEM_PROMPT, opts.signal);
	} catch {
		return "agent";
	}

	return parseIntent(raw) ?? "agent";
}

export function isGreeting(message: string): boolean {
	if (message.split(/\s+/).length > 4) return false;
	return GREETING_PATTERNS.some((re) => re.test(message));
}

export function parseIntent(raw: string): Intent | null {
	const word = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	if (word === "agent") return "agent";
	if (word === "plan") return "plan";
	if (word === "chat") return "chat";
	if (word === "clarify") return "clarify";
	// Be lenient: take the first matching token from a longer reply.
	for (const candidate of raw.toLowerCase().split(/[^a-z]+/)) {
		if (candidate === "agent" || candidate === "plan" || candidate === "chat" || candidate === "clarify") {
			return candidate as Intent;
		}
	}
	return null;
}
