import { getEnvApiKey, getModel, type KnownProvider, type Model } from "@earendil-works/pi-ai";

/**
 * Provider+model selection, in priority order:
 *   1. CODEBASE_PROVIDER + CODEBASE_MODEL env (explicit override)
 *   2. First provider in {@link AUTO_DETECT_ORDER} with a usable env key
 *   3. Throw — caller should surface this as an onboarding hint
 *
 * pi-ai's `getEnvApiKey` already handles every quirky case: OAuth-only
 * providers, Vertex ADC, AWS multi-source. We just trust it.
 */

const AUTO_DETECT_ORDER: readonly KnownProvider[] = [
	"anthropic",
	"openai",
	"groq",
	"google",
	"mistral",
	"deepseek",
	"cerebras",
	"xai",
	"openrouter",
] as const;

const DEFAULT_MODELS: Partial<Record<KnownProvider, string>> = {
	anthropic: "claude-sonnet-4-6",
	openai: "gpt-5.1",
	groq: "llama-3.3-70b-versatile",
	google: "gemini-2.5-pro",
	mistral: "mistral-large-latest",
	deepseek: "deepseek-chat",
	cerebras: "llama-3.3-70b",
	xai: "grok-4",
	openrouter: "anthropic/claude-sonnet-4-6",
};

export interface ResolvedConfig {
	model: Model<string>;
	apiKey: string;
	source: "explicit" | "auto";
}

export class ConfigError extends Error {}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const explicitProvider = env.CODEBASE_PROVIDER as KnownProvider | undefined;
	const explicitModel = env.CODEBASE_MODEL;

	if (explicitProvider && explicitModel) {
		const model = getModel(explicitProvider, explicitModel as never);
		if (!model) {
			throw new ConfigError(
				`CODEBASE_PROVIDER=${explicitProvider} CODEBASE_MODEL=${explicitModel} not in pi-ai's model registry. ` +
					`Check the spelling, or unset both to auto-detect.`,
			);
		}
		const apiKey = getEnvApiKey(explicitProvider);
		if (!apiKey) {
			throw new ConfigError(
				`CODEBASE_PROVIDER=${explicitProvider} has no API key in env. Set the appropriate *_API_KEY var.`,
			);
		}
		return { model, apiKey, source: "explicit" };
	}

	for (const provider of AUTO_DETECT_ORDER) {
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) continue;

		const modelId = DEFAULT_MODELS[provider];
		if (!modelId) continue;

		const model = getModel(provider, modelId as never);
		if (!model) continue;

		return { model, apiKey, source: "auto" };
	}

	throw new ConfigError(
		"No usable LLM provider found. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, " +
			"GOOGLE_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, CEREBRAS_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY. " +
			"Or set CODEBASE_PROVIDER + CODEBASE_MODEL explicitly.",
	);
}
