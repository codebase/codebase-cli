import type { AgentBundle } from "../agent/agent.js";
import { UserQueryCancelled } from "../user-queries/store.js";
import { buildAgentPrompt, generatePlan, generateQuestion, MAX_QUESTIONS, parseAnswer, revisePlan } from "./flow.js";
import { ANSWER_START_BUILDING, type QAPair } from "./types.js";

export interface PlanFlowHandlers {
	/** Render a synthetic assistant message (plan body, cancel notice). */
	onReply: (text: string) => void;
	/** Surface a plan-flow failure to the user. */
	onError: (message: string) => void;
}

/**
 * Plan-mode flow:
 *   1. Q&A loop (up to MAX_QUESTIONS, with the start-building escape).
 *   2. Generate plan, render as a synthetic assistant message so the
 *      user can read it in chat.
 *   3. Approve / Revise / Cancel via the UserQuery primitive.
 *   4. On approve, hand the original prompt + plan + Q&A to the agent
 *      with the canonical buildAgentPrompt wrapper so weaker models
 *      stick to the plan instead of re-planning mid-execution.
 */
export async function runPlanFlow(
	bundle: AgentBundle,
	originalPrompt: string,
	handlers: PlanFlowHandlers,
): Promise<void> {
	const { onReply, onError } = handlers;
	const qaHistory: QAPair[] = [];
	try {
		for (let i = 0; i < MAX_QUESTIONS; i++) {
			const result = await generateQuestion(bundle.glue, originalPrompt, qaHistory, i);
			if (result.done || !result.question) break;
			const q = result.question;
			const optionLabels = q.options?.map((o) => o.label);
			const answer = await bundle.userQueries.ask({
				question: q.question,
				options: optionLabels,
				placeholder: optionLabels ? `1-${optionLabels.length}, or type a free-form answer` : undefined,
			});
			const resolved = parseAnswer(answer, q);
			if (resolved === ANSWER_START_BUILDING) break;
			qaHistory.push({ question: q.question, answer: resolved });
		}

		let plan = await generatePlan(bundle.glue, originalPrompt, qaHistory);

		while (true) {
			onReply(plan);
			const decision = await bundle.userQueries.ask({
				question: "Approve this plan and run it?",
				options: ["Yes — run it", "Revise", "Cancel"],
			});
			const choice = matchOption(decision, ["Yes — run it", "Revise", "Cancel"]);
			if (choice === "Yes — run it") {
				const finalPrompt = buildAgentPrompt(originalPrompt, plan, qaHistory);
				bundle.agent.prompt(finalPrompt).catch((err: unknown) => {
					onError(err instanceof Error ? err.message : String(err));
				});
				return;
			}
			if (choice === "Cancel") {
				onReply("(plan cancelled)");
				return;
			}
			const feedback = await bundle.userQueries.ask({
				question: "What should change about the plan?",
				placeholder: "describe the revision",
			});
			plan = await revisePlan(bundle.glue, plan, feedback);
		}
	} catch (err) {
		if (err instanceof UserQueryCancelled) {
			onReply("(plan cancelled)");
			return;
		}
		onError(`plan flow failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Resolve a user's typed answer to one of the supplied options.
 * Accepts the option label (case-insensitive), a 1-based index,
 * or the leading word of the label. Falls back to the raw input
 * if nothing matches — caller decides what to do with that.
 */
function matchOption(answer: string, options: string[]): string {
	const trimmed = answer.trim();
	const idx = Number.parseInt(trimmed, 10);
	if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
		return options[idx - 1];
	}
	const lower = trimmed.toLowerCase();
	for (const option of options) {
		if (option.toLowerCase() === lower) return option;
		if (option.toLowerCase().startsWith(lower) && lower.length >= 3) return option;
	}
	return trimmed;
}
