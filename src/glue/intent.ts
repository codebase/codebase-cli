import type { GlueClient } from "./client.js";

/**
 * Intent classifications the router actually acts on. "chat" used to
 * be in this set but was removed when we ripped out the
 * cheap-model chat intercept — small talk now goes to the main agent.
 * "clarify" remains so we can wire an ask-back path later, but for
 * now it routes the same as "agent".
 */
export type Intent = "agent" | "plan" | "clarify";

const INTENT_SYSTEM_PROMPT = `Classify the user's message into ONE of these intents. Output exactly one word, no prose.

- agent: a coding, automation, build, fix, or run-the-tools request. Default for anything actionable, including small talk, greetings, gratitude, and meta-questions about the agent itself — the main agent handles those directly now.
- plan: the user explicitly asked for a plan, planning mode, or for planning before code is written.
- clarify: ambiguous or contradictory request where acting without more information would be a mistake.

Reply with exactly one of: agent | plan | clarify.`;

export interface ClassifyOptions {
	hasHistory: boolean;
	signal?: AbortSignal;
}

/**
 * Decide whether the user's message should auto-trigger plan mode
 * (Q&A → reviewable plan → agent execution) or just fall through to
 * the main agent. Greetings and meta-questions used to get a
 * "chat" short-circuit; that's gone — the main agent answers those
 * itself now.
 *
 * On LLM error or unparseable output, defaults to "agent". Failing
 * open is preferable to silently swallowing a real request because a
 * cheap classifier model hiccuped.
 */
export async function classifyIntent(glue: GlueClient, message: string, opts: ClassifyOptions): Promise<Intent> {
	const trimmed = message.trim();
	if (!trimmed) return "clarify";
	// The planning flow cannot inspect the repository. Sending a complex but
	// actionable request there encourages guessed paths and redundant questions.
	// The main agent can inspect first and enter tool-aware plan mode itself.
	if (!isExplicitPlanRequest(trimmed)) return "agent";

	let raw: string;
	try {
		raw = await glue.fast(trimmed, INTENT_SYSTEM_PROMPT, opts.signal);
	} catch {
		return "agent";
	}

	return parseIntent(raw) ?? "agent";
}

export function isExplicitPlanRequest(message: string): boolean {
	const normalized = message.toLowerCase().replace(/[’]/g, "'");
	if (
		/\b(?:do not|don't|dont|without)\s+(?:make|create|write|draft|give|show)?\s*(?:me\s+)?(?:an?\s+)?(?:implementation\s+)?plan\b/.test(
			normalized,
		)
	) {
		return false;
	}
	return [
		/\bplan\s+(?:this|it|the|my|our|a|an)\b/,
		/\b(?:make|create|write|draft|give|show)\s+(?:me\s+)?(?:an?\s+)?(?:implementation\s+)?plan\b/,
		/\b(?:want|need|would like)\s+(?:you\s+to\s+)?(?:an?\s+)?(?:implementation\s+)?plan\b/,
		/\b(?:enter|use|start)\s+plan(?:ning)?\s+mode\b/,
		/\b(?:plan|planning)\s+(?:first|before\s+(?:coding|editing|implementing|changes))\b/,
	].some((pattern) => pattern.test(normalized));
}

export function parseIntent(raw: string): Intent | null {
	const word = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	if (word === "agent") return "agent";
	if (word === "plan") return "plan";
	if (word === "clarify") return "clarify";
	// Lenient pass: pick the first matching token from a longer reply so a
	// chatty cheap model that ignores the "one word" instruction doesn't
	// silently fall through to the "agent" default.
	for (const candidate of raw.toLowerCase().split(/[^a-z]+/)) {
		if (candidate === "agent" || candidate === "plan" || candidate === "clarify") {
			return candidate;
		}
	}
	return null;
}
