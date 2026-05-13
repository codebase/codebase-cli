import { useEffect, useRef, useState } from "react";
import type { AgentBundle } from "../agent/agent.js";
import { generateSuggestion } from "../agent/prompt-suggestion.js";

/**
 * Inline prompt-suggestion ghost text. Schedules a single forecast
 * call when the agent goes idle; cancels the prior call on every new
 * state change so we never race two suggestions or show a stale one
 * after the user starts a new turn. 500ms debounce lets idle settle
 * (e.g. agent finishes, a quick status emit follows, we don't want to
 * fire twice). Disabled via env so users on metered BYOK providers
 * can opt out.
 */
export function usePromptSuggestion(
	bundle: AgentBundle,
	status: string,
	messageCount: number,
): { suggestion: string | null; dismiss: () => void } {
	const [suggestion, setSuggestion] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		// Always clear any active suggestion on state change — it was
		// computed for the previous turn and the user has moved on.
		setSuggestion(null);
		abortRef.current?.abort();
		abortRef.current = null;

		if (process.env.CODEBASE_NO_SUGGESTIONS === "1") return;
		if (status !== "idle") return;
		if (messageCount < 2) return;

		const ac = new AbortController();
		abortRef.current = ac;
		const timer = setTimeout(async () => {
			if (ac.signal.aborted) return;
			try {
				const text = await generateSuggestion(bundle, { signal: ac.signal });
				if (ac.signal.aborted) return;
				if (text) setSuggestion(text);
			} catch {
				// Suggestion failures are silent — they're a nicety, not load-bearing.
			}
		}, 500);

		return () => {
			clearTimeout(timer);
			ac.abort();
			if (abortRef.current === ac) abortRef.current = null;
		};
	}, [bundle, status, messageCount]);

	return { suggestion, dismiss: () => setSuggestion(null) };
}
