import type { GlueClient } from "../glue/client.js";
import {
	AGENT_PROMPT_FOOTER,
	AGENT_PROMPT_HEADER,
	PLAN_SYSTEM_PROMPT,
	QUESTION_SYSTEM_PROMPT,
	REVISE_SYSTEM_PROMPT,
} from "./prompts.js";
import { ANSWER_START_BUILDING, type PlanQuestion, type QAPair } from "./types.js";

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;

export interface QuestionResult {
	question?: PlanQuestion;
	done: boolean;
	reason?: string;
}

/**
 * Ask the smart-glue model for the next clarifying question.
 *   - questionNum < MAX_QUESTIONS: returns a question or done=true
 *   - questionNum >= MAX_QUESTIONS: forces done=true to bound the loop
 *   - questionNum < MIN_QUESTIONS: refuses to mark done=true; if the
 *     model insists, we keep going and synthesize a generic question.
 */
export async function generateQuestion(
	glue: GlueClient,
	originalPrompt: string,
	qaHistory: QAPair[],
	questionNum: number,
	signal?: AbortSignal,
): Promise<QuestionResult> {
	if (questionNum >= MAX_QUESTIONS) {
		return { done: true, reason: `reached max ${MAX_QUESTIONS} questions` };
	}

	const prompt = buildQuestionPrompt(originalPrompt, qaHistory);
	let raw: string;
	try {
		raw = await glue.smart(prompt, QUESTION_SYSTEM_PROMPT, signal);
	} catch (err) {
		return { done: true, reason: `glue error: ${err instanceof Error ? err.message : String(err)}` };
	}

	const parsed = extractJson(raw);
	if (!parsed) return { done: true, reason: "LLM returned no parseable JSON" };

	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"done" in parsed &&
		(parsed as { done?: unknown }).done === true
	) {
		if (questionNum < MIN_QUESTIONS) {
			// Model wants to stop too early — ask one synthesized fallback.
			return {
				question: {
					id: `q${questionNum + 1}`,
					question: "What's the most important constraint or non-goal for this work?",
				},
				done: false,
			};
		}
		return { done: true };
	}

	const q = normalizeQuestion(parsed, questionNum);
	if (!q) return { done: true, reason: "could not normalize question payload" };
	return { question: q, done: false };
}

/** Generate a complete plan markdown from the original prompt + Q&A history. */
export async function generatePlan(
	glue: GlueClient,
	originalPrompt: string,
	qaHistory: QAPair[],
	signal?: AbortSignal,
): Promise<string> {
	const prompt = buildPlanPrompt(originalPrompt, qaHistory);
	const raw = await glue.smart(prompt, PLAN_SYSTEM_PROMPT, signal);
	return raw.trim();
}

/** Apply user feedback to an existing plan and return the full revised plan. */
export async function revisePlan(
	glue: GlueClient,
	currentPlan: string,
	feedback: string,
	signal?: AbortSignal,
): Promise<string> {
	const prompt = `Current plan:\n\n${currentPlan}\n\nUser feedback:\n${feedback}`;
	const raw = await glue.smart(prompt, REVISE_SYSTEM_PROMPT, signal);
	return raw.trim();
}

/**
 * Wrap the approved plan as the prompt the main agent will receive.
 * Header + footer phrasing is tuned to keep weaker models on-plan; do
 * not casually rewrite them.
 */
export function buildAgentPrompt(originalPrompt: string, plan: string, qaHistory: QAPair[]): string {
	const lines: string[] = [AGENT_PROMPT_HEADER, "", `Original request: ${originalPrompt}`];
	if (qaHistory.length > 0) {
		lines.push("", "Clarifications:");
		for (const qa of qaHistory) {
			lines.push(`- Q: ${qa.question}`);
			lines.push(`  A: ${qa.answer}`);
		}
	}
	lines.push("", "Plan:", plan, "", AGENT_PROMPT_FOOTER);
	return lines.join("\n");
}

/**
 * Interpret raw user input as an answer to a multiple-choice question.
 *   - 1-based number matching an option → the option's label
 *   - exact label match (case-insensitive) → the canonical label
 *   - input that matches the "start building" escape number → ANSWER_START_BUILDING
 *   - anything else → the trimmed raw input (free-form)
 */
export function parseAnswer(input: string, question: PlanQuestion | undefined): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (!question?.options || question.options.length === 0) return trimmed;

	const idx = Number.parseInt(trimmed, 10);
	if (Number.isFinite(idx)) {
		if (idx >= 1 && idx <= question.options.length) {
			return question.options[idx - 1].label;
		}
		// Escape: option count + 1 means "start building, skip remaining questions".
		if (idx === question.options.length + 1) return ANSWER_START_BUILDING;
	}

	const exact = question.options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact.label;

	return trimmed;
}

// ─── helpers ──────────────────────────────────────────────────

function buildQuestionPrompt(originalPrompt: string, qaHistory: QAPair[]): string {
	const lines: string[] = [`User request: ${originalPrompt}`];
	if (qaHistory.length > 0) {
		lines.push("", "Q&A so far:");
		for (const qa of qaHistory) {
			lines.push(`Q: ${qa.question}`);
			lines.push(`A: ${qa.answer}`);
		}
	} else {
		lines.push("", "(no clarifications yet)");
	}
	return lines.join("\n");
}

function buildPlanPrompt(originalPrompt: string, qaHistory: QAPair[]): string {
	const lines: string[] = [`User request: ${originalPrompt}`];
	if (qaHistory.length > 0) {
		lines.push("", "Clarifications:");
		for (const qa of qaHistory) {
			lines.push(`Q: ${qa.question}`);
			lines.push(`A: ${qa.answer}`);
		}
	}
	return lines.join("\n");
}

/**
 * Extract a JSON object from a possibly-noisy LLM response. Some cheap
 * models prefix or suffix prose; this finds the first balanced { ... }
 * span and parses that. Returns null if nothing parses.
 */
export function extractJson(raw: string): unknown {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through
	}
	const start = trimmed.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let inEscape = false;
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (inEscape) {
			inEscape = false;
			continue;
		}
		if (ch === "\\" && inString) {
			inEscape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const candidate = trimmed.slice(start, i + 1);
				try {
					return JSON.parse(candidate);
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function normalizeQuestion(raw: unknown, questionNum: number): PlanQuestion | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { question?: unknown; options?: unknown };
	if (typeof r.question !== "string" || !r.question.trim()) return null;
	let options: PlanQuestion["options"];
	if (Array.isArray(r.options)) {
		options = r.options
			.map((o, i) => normalizeOption(o, i))
			.filter((o): o is { id: string; label: string; description?: string } => o !== null);
		if (options.length === 0) options = undefined;
	}
	return {
		id: `q${questionNum + 1}`,
		question: r.question.trim(),
		options,
	};
}

function normalizeOption(raw: unknown, idx: number): { id: string; label: string; description?: string } | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { id?: unknown; label?: unknown; description?: unknown };
	if (typeof r.label !== "string" || !r.label.trim()) return null;
	return {
		id: typeof r.id === "string" && r.id.trim() ? r.id : `opt${idx + 1}`,
		label: r.label.trim(),
		description: typeof r.description === "string" ? r.description : undefined,
	};
}
