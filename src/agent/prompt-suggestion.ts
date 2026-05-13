import { completeSimple } from "@earendil-works/pi-ai";
import type { AgentBundle } from "./agent.js";

/**
 * Prompt-suggestion ghost-text generation. After the agent goes idle,
 * we issue a one-shot side call on the user's main model that reuses
 * the parent's system prompt + conversation prefix and asks the model
 * to predict the user's next input as a short string. The matching
 * prefix lets the upstream's prompt cache reuse the parent's work, so
 * the marginal cost is approximately the suggestion's own output
 * tokens.
 *
 * Cost notes by provider:
 *   - Codebase Auto: zero marginal cost (in-house inference).
 *   - Anthropic / OpenAI: small (native prompt caching hits the prefix).
 *   - Other BYOK upstreams (Groq, Mistral, …): a small uncached call
 *     per suggestion. Disable via CODEBASE_NO_SUGGESTIONS=1.
 */

/**
 * Instructions appended as a final user message. Meta-prompts the model
 * to predict the user's next input rather than respond as the assistant.
 */
const SUGGESTION_PROMPT = `Switching to autocomplete mode for one reply.

Reread the conversation so far and forecast the user's next message — the words they themselves would type into the input box, not advice about what they should do.

Calibration: if the user would read your reply and think "yeah, I was about to send that," you nailed it. If they'd read it and think "the assistant is talking to me," you missed.

Guideline patterns:
- After a job that finished cleanly, the next ask is usually the obvious follow-through: run the tests, push the commit, open the PR, ship it.
- When you (the assistant) listed options, prefer the one the user clearly wants given the thread above.
- When you asked a yes/no, pick the answer their tone implies.
- When the last assistant turn was a stack trace, a clarifying question, or anything where the user needs a beat to react: produce nothing.

Things that disqualify a suggestion:
- Anything in your own voice ("I'll handle it", "Let me check", "Here's a plan").
- Praise or filler the user would never type to drive forward ("nice", "looks great", "thanks").
- Open-ended questions thrown back at you ("what do you think?").
- A pivot to a new topic the user didn't ask about.
- More than one sentence; more than about a dozen words.

Output: just the predicted user message, no quotes, no preamble, no trailing punctuation flourish. If nothing fits, return an empty reply.`;

/** Don't suggest before this many assistant turns — needs context to predict from. */
const MIN_ASSISTANT_TURNS = 2;

/** Cap output so a runaway model can't burn tokens. 60 ≈ 12 words × 5 token/word, with slack. */
const MAX_SUGGESTION_TOKENS = 60;

/**
 * Try to produce a suggestion for the current conversation. Returns null
 * when we shouldn't suggest (early turn, last response was an error,
 * abort fired, model returned empty or filtered text).
 */
export async function generateSuggestion(
	bundle: AgentBundle,
	options: { signal?: AbortSignal } = {},
): Promise<string | null> {
	const agentState = bundle.agent.state;
	const messages = agentState.messages;

	// Need at least a couple assistant turns to predict from — anything
	// less and the suggestion is guessing into the void.
	const assistantTurnCount = messages.reduce((n, m) => n + (m.role === "assistant" ? 1 : 0), 0);
	if (assistantTurnCount < MIN_ASSISTANT_TURNS) return null;

	// If the latest assistant message errored, the user should read/react,
	// not be nudged to type more.
	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
	if (lastAssistant && "errorMessage" in lastAssistant && lastAssistant.errorMessage) return null;

	const suggestionMessages = [
		...messages,
		{
			role: "user" as const,
			content: SUGGESTION_PROMPT,
			timestamp: Date.now(),
		},
	];

	let assistantMessage: Awaited<ReturnType<typeof completeSimple>>;
	try {
		assistantMessage = await completeSimple(
			agentState.model,
			{
				systemPrompt: agentState.systemPrompt,
				messages: suggestionMessages,
			},
			{
				signal: options.signal,
				maxTokens: MAX_SUGGESTION_TOKENS,
				temperature: 0.7,
				// `cacheRetention: "short"` is pi-ai's default — keeps the
				// suggestion fork from extending the parent's cache TTL,
				// which the agent loop manages on its own.
			},
		);
	} catch {
		return null;
	}

	const text = extractText(assistantMessage).trim();
	if (!text) return null;
	if (shouldFilterSuggestion(text)) return null;

	return text;
}

function extractText(message: Awaited<ReturnType<typeof completeSimple>>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("");
}

/**
 * Filter out suggestions that don't look like real user input. Catches
 * the things the model emits when it doesn't know what to suggest but
 * isn't willing to stay silent.
 */
function shouldFilterSuggestion(text: string): boolean {
	const lower = text.toLowerCase();
	if (lower === "done" || lower === "done.") return true;
	if (lower === "nothing found" || lower === "nothing found.") return true;
	if (lower.startsWith("nothing to suggest") || lower.startsWith("no suggestion")) return true;
	if (/\bstay(s|ing)? silent\b|\bsilence is\b/.test(lower)) return true;
	if (/^\W*silence\W*$/.test(lower)) return true;
	// Assistant-voice slippage — model addresses the user as if it were
	// replying in-character instead of predicting their input.
	if (/^(let me|i('|\s)ll|here('|\s)s|i can|i('|\s)d)\b/i.test(text)) return true;
	// Evaluative one-liners — these aren't actions, they're chitchat the
	// user wouldn't typically type to drive forward.
	if (/^(looks good|thanks|nice|great|ok|okay|yes)\.?$/i.test(text.trim())) return true;
	// Too long — keep ghost-text legible in the input row.
	if (text.split(/\s+/).length > 12) return true;
	// Multi-sentence — pick a single utterance.
	if (/[.!?]\s+\S/.test(text)) return true;
	return false;
}
