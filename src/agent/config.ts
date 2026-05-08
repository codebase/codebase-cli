import { getEnvApiKey, getModel, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import { CredentialsStore } from "../auth/credentials.js";

/**
 * Provider+model selection, in priority order:
 *   1. Saved OAuth/API credentials (~/.codebase/credentials.json) — if
 *      present and not expired, route the chosen model through the
 *      codebase.foundation inference proxy so the backend can deduct
 *      credits. The model metadata stays the same; only baseUrl + apiKey
 *      change.
 *   2. CODEBASE_PROVIDER + CODEBASE_MODEL env (explicit override)
 *   3. First provider in {@link AUTO_DETECT_ORDER} with a usable env key
 *   4. Throw — caller should surface this as an onboarding hint
 *
 * pi-ai's `getEnvApiKey` already handles every quirky case: OAuth-only
 * providers, Vertex ADC, AWS multi-source. We just trust it.
 */

// The web's inference proxy lives under /api/inference/* — see
// docs/oauth-web-alignment-2026-05-08.md. pi-ai's per-protocol path
// appending lands the request on /api/inference/v1/messages
// (Anthropic) or /api/inference/chat (OpenAI-compat) once baseUrl
// points here.
const DEFAULT_PROXY_BASE = "https://codebase.design/api/inference";

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
	openrouter: "anthropic/claude-sonnet-4",
};

export interface ResolvedConfig {
	model: Model<string>;
	apiKey: string;
	source: "explicit" | "auto" | "proxy" | "byok";
}

export class ConfigError extends Error {}

export interface ResolveConfigOptions {
	env?: NodeJS.ProcessEnv;
	credentials?: CredentialsStore;
}

export function resolveConfig(envOrOpts: NodeJS.ProcessEnv | ResolveConfigOptions = process.env): ResolvedConfig {
	const opts = isProcessEnv(envOrOpts) ? { env: envOrOpts } : envOrOpts;
	const env = opts.env ?? process.env;
	const credentials = opts.credentials ?? new CredentialsStore();

	// 1. Saved credentials. Routing depends on the source:
	//    - codebase / manual → proxy through codebase.design
	//    - byok               → direct call against the provider's own API
	const useProxy = env.CODEBASE_DISABLE_PROXY !== "1";
	const creds = credentials.load();
	if (creds && !credentials.isExpired(creds)) {
		if (creds.source === "byok" && creds.provider) {
			const byok = buildByokConfig(creds.provider as KnownProvider, creds.accessToken);
			if (byok) return byok;
		} else if (useProxy) {
			const proxied = buildProxiedConfig(env, creds.accessToken);
			if (proxied) return proxied;
		}
	}

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
		"No usable LLM provider found. Sign in with `codebase auth login`, paste an API key with " +
			"`codebase auth <key>`, or set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, " +
			"GOOGLE_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, CEREBRAS_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY. " +
			"Or set CODEBASE_PROVIDER + CODEBASE_MODEL explicitly.",
	);
}

/**
 * Build a model whose baseUrl points at the codebase.foundation
 * inference proxy. The proxy MUST mimic the chosen provider's wire
 * protocol (Anthropic Messages, OpenAI Responses, etc.) — what we send
 * here is identical to a direct call, the bearer token is the only
 * thing that changes.
 */
function buildProxiedConfig(env: NodeJS.ProcessEnv, accessToken: string): ResolvedConfig | null {
	const explicitProvider = env.CODEBASE_PROVIDER as KnownProvider | undefined;
	const explicitModel = env.CODEBASE_MODEL;
	const provider = explicitProvider ?? "anthropic";
	const modelId = explicitModel ?? DEFAULT_MODELS[provider];
	if (!modelId) return null;

	const baseModel = getModel(provider, modelId as never) as Model<string> | undefined;
	if (!baseModel) return null;

	const proxyBase = (env.CODEBASE_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE).replace(/\/+$/, "");
	const proxiedModel: Model<string> = { ...baseModel, baseUrl: proxyBase };
	return { model: proxiedModel, apiKey: accessToken, source: "proxy" };
}

/**
 * BYOK mode: caller has saved a provider's own API key. Use the
 * provider's normal baseUrl from pi-ai's registry — no proxy.
 */
function buildByokConfig(provider: KnownProvider, apiKey: string): ResolvedConfig | null {
	const modelId = DEFAULT_MODELS[provider];
	if (!modelId) return null;
	const model = getModel(provider, modelId as never) as Model<string> | undefined;
	if (!model) return null;
	return { model, apiKey, source: "byok" };
}

function isProcessEnv(value: NodeJS.ProcessEnv | ResolveConfigOptions): value is NodeJS.ProcessEnv {
	if (!value) return true;
	// ResolveConfigOptions has at most env/credentials properties; ProcessEnv has many.
	const keys = Object.keys(value);
	if (keys.length === 0) return true;
	return !keys.every((k) => k === "env" || k === "credentials");
}
