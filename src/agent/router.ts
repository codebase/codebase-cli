import type { GlueClient } from "../glue/client.js";
import { classifyIntent } from "../glue/intent.js";

const CHAT_SYSTEM_PROMPT =
	"You're chatting casually with the user — small talk, gratitude, greetings, meta-questions. Reply briefly (one or two sentences), warm tone, no code unless explicitly asked.";

export type RouteOutcome = { kind: "agent" } | { kind: "chat"; reply: string } | { kind: "plan" };

export interface RouteOptions {
	hasHistory: boolean;
	signal?: AbortSignal;
}

/**
 * Decide what to do with a user input before involving the main agent:
 *   - "chat" → glue reply, no agent run (greetings, thanks, meta)
 *   - "plan" → caller enters the plan flow (Q&A → reviewable plan → agent)
 *   - "agent" → fall through to agent.prompt as before
 *
 * Glue failures degrade to "agent" so a flaky cheap model never silently
 * eats a real request — same fallback policy classifyIntent already uses.
 */
export async function routeUserInput(glue: GlueClient, text: string, options: RouteOptions): Promise<RouteOutcome> {
	const intent = await classifyIntent(glue, text, options);
	if (intent === "chat") {
		const reply = await chatReply(glue, text, options.signal);
		return { kind: "chat", reply };
	}
	if (intent === "plan") {
		return { kind: "plan" };
	}
	// agent + clarify both go through the main agent for now; clarify-as-soft-hint
	// could surface a system reminder when we wire steering messages in Phase 11b.
	return { kind: "agent" };
}

async function chatReply(glue: GlueClient, text: string, signal?: AbortSignal): Promise<string> {
	try {
		const out = await glue.fast(text, CHAT_SYSTEM_PROMPT, signal);
		return out.trim() || "👍";
	} catch {
		// Glue down — at least acknowledge so the input row isn't dead silent.
		return "👍";
	}
}
