import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

const Params = Type.Object({
	label: Type.String({
		minLength: 1,
		maxLength: 80,
		description: 'Short label shown on the copy box, e.g. "run this" or "your API key".',
	}),
	content: Type.String({
		minLength: 1,
		maxLength: 100_000,
		description: "The exact text the user should be able to copy — a command, snippet, key, config blob, etc.",
	}),
});

export type PresentCopyParams = Static<typeof Params>;

export interface PresentCopyDetails {
	label: string;
	bytes: number;
}

const DESCRIPTION = `Surface a click-to-copy box in the user's terminal for text you want them to copy verbatim — a command to run, a generated key, a config snippet, a path.

The box is clickable (and clean-copyable) in the pi-tui UI; in other render paths it shows as a labeled block. Use this instead of burying a must-copy value in prose. Prefer it for one discrete payload; for ordinary code in an explanation, a normal fenced code block already renders as a copy box.

The user sees the box; you get back only an acknowledgement.`;

/**
 * Lets the agent present a discrete, click-to-copy payload to the user.
 * The UI renders the args (label + content) as a CopyBox; the tool result
 * is just an ack so the model isn't handed the content back.
 */
export function createPresentCopy(): AgentTool<typeof Params, PresentCopyDetails> {
	return {
		name: "present_copy",
		label: "Copy box",
		description: DESCRIPTION,
		parameters: Params,
		execute: async (_toolCallId, params) => ({
			content: [
				{
					type: "text",
					text: `Presented a copy box "${params.label}" (${params.content.length} chars) to the user.`,
				},
			],
			details: { label: params.label, bytes: params.content.length },
		}),
	};
}
