import type { GlueClient } from "./client.js";

const TITLE_SYSTEM_PROMPT =
	"Summarize the user's request as a 2-6 word title. Return only the title, no quotes or punctuation.";

const NARRATE_SYSTEM_PROMPT =
	"Write a one-line status describing what just happened (≤80 chars). Past tense, terse, no punctuation at the end.";

const FOLLOWUP_SYSTEM_PROMPT = `Based on what was just done, suggest 1-3 short follow-up actions the user might want next. Return them as a bullet list, each line starting with "- " and ≤60 chars.`;

const TITLE_MAX_CHARS = 50;
const NARRATION_MAX_CHARS = 80;

/** Generate a 2-6 word title for a user request. Falls back to a truncated request. */
export async function generateTitle(glue: GlueClient, userMessage: string, signal?: AbortSignal): Promise<string> {
	const fallback = clamp(userMessage.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
	try {
		const raw = await glue.fast(userMessage, TITLE_SYSTEM_PROMPT, signal);
		const title = clamp(stripQuotes(raw.trim()), TITLE_MAX_CHARS);
		return title || fallback;
	} catch {
		return fallback;
	}
}

/** Generate a one-line "what's happening now" narration. Falls back to a generic message. */
export async function narrate(glue: GlueClient, recentActions: string, signal?: AbortSignal): Promise<string> {
	if (!recentActions.trim()) return "Working";
	try {
		const raw = await glue.fast(recentActions, NARRATE_SYSTEM_PROMPT, signal);
		return clamp(raw.trim().replace(/[.!]+$/, ""), NARRATION_MAX_CHARS) || "Working";
	} catch {
		return "Working";
	}
}

/** Suggest 1-3 follow-up actions after a task completes. Falls back to []. */
export async function suggestFollowUps(
	glue: GlueClient,
	taskSummary: string,
	filesChanged: string[],
	signal?: AbortSignal,
): Promise<string[]> {
	const prompt = filesChanged.length
		? `${taskSummary}\n\nFiles changed:\n${filesChanged.slice(0, 10).join("\n")}`
		: taskSummary;
	try {
		const raw = await glue.fast(prompt, FOLLOWUP_SYSTEM_PROMPT, signal);
		return raw
			.split("\n")
			.map((line) => line.replace(/^[-*•]\s*/, "").trim())
			.filter((line) => line.length > 0)
			.slice(0, 3);
	} catch {
		return [];
	}
}

function clamp(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function stripQuotes(s: string): string {
	return s.replace(/^["'`]+|["'`]+$/g, "");
}
