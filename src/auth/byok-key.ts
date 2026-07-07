const PROVIDER_KEY_HINTS: Record<string, { label: string; pattern?: RegExp; example?: string }> = {
	anthropic: { label: "Anthropic", pattern: /^sk-ant-/, example: "sk-ant-" },
	openai: { label: "OpenAI", pattern: /^(sk-|sk-proj-)/, example: "sk- or sk-proj-" },
	groq: { label: "Groq", pattern: /^gsk_/, example: "gsk_" },
	openrouter: { label: "OpenRouter", pattern: /^(sk-or-|sk-or-v1-)/, example: "sk-or-" },
	google: { label: "Google", pattern: /^AI/, example: "AI" },
	xai: { label: "xAI", pattern: /^xai-/, example: "xai-" },
};

export function validateByokApiKey(provider: string, value: string): string | null {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "Paste an API key, or press Esc to go back.";
	if (trimmed.length < 16) return "API key looks too short. Paste the full provider key, or press Esc to go back.";

	const hint = PROVIDER_KEY_HINTS[provider];
	if (!hint?.pattern || hint.pattern.test(trimmed)) return null;

	return `${hint.label} keys usually start with "${hint.example}". Paste the full provider key, or press Esc to go back.`;
}
