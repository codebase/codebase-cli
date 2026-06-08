import type { GlueClient } from "../glue/client.js";
import { classifyIntent } from "../glue/intent.js";

/**
 * Routing decision returned to App.tsx. We only ever return two real
 * destinations now — the main agent or the plan flow. The chat path
 * (intercepting small-talk/meta-questions with a cheap glue model) was
 * removed because it made the CLI confidently hallucinate identity and
 * capability when the user asked the obvious meta questions. All
 * conversation now goes through the agent, which has tools and the
 * actual system prompt.
 */
export type RouteOutcome = { kind: "agent" } | { kind: "plan" };

export interface RouteOptions {
	hasHistory: boolean;
	signal?: AbortSignal;
}

/**
 * Decide whether the user's input should auto-trigger plan mode (the
 * Q&A → reviewable-plan → agent-execution flow) or just hit the main
 * agent. Glue is consulted only for the plan/agent split — if it
 * returns any other intent, or the call fails, we default to the
 * agent. Failing-open keeps a flaky cheap model from silently eating
 * real requests.
 */
export async function routeUserInput(glue: GlueClient, text: string, options: RouteOptions): Promise<RouteOutcome> {
	const intent = await classifyIntent(glue, text, options);
	if (intent === "plan") {
		return { kind: "plan" };
	}
	return { kind: "agent" };
}
