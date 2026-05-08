import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	question: Type.String({
		minLength: 1,
		maxLength: 1000,
		description: "Question to ask the user. Be specific — the user types a free-form answer.",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 2,
			maxItems: 8,
			description:
				"Optional list of choices. The user can type the option text, the option number (1-based), or anything else as a free-form answer.",
		}),
	),
	placeholder: Type.Optional(
		Type.String({
			description: "Hint shown in the input row, e.g. 'y/n' or 'tag name'.",
		}),
	),
});

export type AskUserParams = Static<typeof Params>;

export interface AskUserDetails {
	question: string;
	answer: string;
	matchedOption: string | null;
}

const DESCRIPTION = `Ask the user a question and wait for a typed answer.

When to use:
- Genuine ambiguity that affects the next step ("which deploy target?"). Don't use it for things you can figure out from the code.
- Confirming destructive operations beyond what the permission gate already covers (rare).
- Multiple-choice selection: pass options[] and the UI will offer 1/2/3-style shortcuts.

Behavior:
- The agent loop blocks until the user types something and submits.
- If options are supplied and the user types a 1-based number that matches one, the matched option text is returned in matchedOption; the original typed text is in answer.
- Aborting the agent (Ctrl-C) cancels the question and the tool errors out so the agent can decide what to do next.`;

export function createAskUser(ctx: ToolContext): AgentTool<typeof Params, AskUserDetails> {
	return {
		name: "ask_user",
		label: "Ask",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const answer = await ctx.userQueries.ask({
				question: params.question,
				options: params.options,
				placeholder: params.placeholder,
			});

			let matchedOption: string | null = null;
			if (params.options && params.options.length > 0) {
				const trimmed = answer.trim();
				const idx = Number.parseInt(trimmed, 10);
				if (Number.isFinite(idx) && idx >= 1 && idx <= params.options.length) {
					matchedOption = params.options[idx - 1];
				} else {
					const exact = params.options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
					if (exact) matchedOption = exact;
				}
			}

			return {
				content: [{ type: "text", text: matchedOption ? `${matchedOption} (typed: ${answer})` : answer }],
				details: { question: params.question, answer, matchedOption },
			};
		},
	};
}
