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
	/**
	 * Runtime model override. When set on an OAuth/proxy session, replaces
	 * the resolved model id (and optionally provider) so a user can swap
	 * mid-session via `/model <id>` without restarting. Ignored when no
	 * proxy session is active.
	 */
	modelOverride?: { provider?: string; modelId: string };
}

export function resolveConfig(envOrOpts: NodeJS.ProcessEnv | ResolveConfigOptions = process.env): ResolvedConfig {
	const opts = isProcessEnv(envOrOpts) ? { env: envOrOpts } : envOrOpts;
	const env = opts.env ?? process.env;
	const credentials = opts.credentials ?? new CredentialsStore();
	const override = opts.modelOverride;

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
			const proxied = buildProxiedConfig(env, creds.accessToken, override);
			if (proxied) return proxied;
		}
	}

	// 2. OpenAI-compatible custom endpoint. Triggers when the user has
	//    set OPENAI_BASE_URL alongside an api key — that combination
	//    only makes sense for a custom Chat Completions backend (Groq,
	//    Ollama, MiniMax in-house, Qwen in-house, vLLM, …). pi-ai's
	//    registry only knows about a fixed set of providers/models, so
	//    we synthesize a Model object on the fly using a known
	//    chat-completions template and overriding id + baseUrl.
	if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY && env.OPENAI_MODEL) {
		const compat = buildOpenAiCompatConfig({
			baseUrl: env.OPENAI_BASE_URL,
			modelId: env.OPENAI_MODEL,
			apiKey: env.OPENAI_API_KEY,
		});
		if (compat) return compat;
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

	// Env-var auto-detect is the legacy power-user path. We only honor it
	// for users who have already onboarded — otherwise a stray
	// ANTHROPIC_API_KEY or OPENAI_API_KEY in the shell would silently
	// skip the OAuth wizard the first time a new user runs `codebase`,
	// even though they almost certainly want the in-house default model
	// with free credits rather than spending their own API key budget.
	//
	// "Already onboarded" = credentials.json exists on disk, even if it's
	// now expired or empty. The wizard creates that file on first
	// sign-in, so its presence is a reliable "this user knows what
	// they're doing" signal.
	const hasOnboarded = credentials.exists();
	if (hasOnboarded) {
		for (const provider of AUTO_DETECT_ORDER) {
			const apiKey = getEnvApiKey(provider);
			if (!apiKey) continue;

			const modelId = DEFAULT_MODELS[provider];
			if (!modelId) continue;

			const model = getModel(provider, modelId as never);
			if (!model) continue;

			return { model, apiKey, source: "auto" };
		}
	}

	throw new ConfigError(
		"No usable LLM provider found. Sign in with `codebase auth login`, paste an API key with " +
			"`codebase auth <key>`, or set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, " +
			"GOOGLE_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, CEREBRAS_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY. " +
			"Or set CODEBASE_PROVIDER + CODEBASE_MODEL explicitly.",
	);
}

/**
 * Build a model that routes through codebase.design's inference proxy.
 *
 * Default when signed in via OAuth: "Codebase Auto" — the in-house
 * MiniMax-M2.7 served via the openai-compat protocol. This matches
 * what the web app calls the same model (`codebase` provider in
 * web/backend/providers/registry.js).
 *
 * Override via env: CODEBASE_PROVIDER + CODEBASE_MODEL still pick a
 * specific upstream from pi-ai's registry, also routed through the
 * proxy. The proxy dispatches by the model id in the request body +
 * the bearer scope on the token, so this works for any model the
 * user's account has access to.
 */
function buildProxiedConfig(
	env: NodeJS.ProcessEnv,
	accessToken: string,
	override?: { provider?: string; modelId: string },
): ResolvedConfig | null {
	// Runtime override (set via /model) wins over env vars wins over the default.
	const explicitProvider = (override?.provider ?? env.CODEBASE_PROVIDER) as KnownProvider | undefined;
	const explicitModel = override?.modelId ?? env.CODEBASE_MODEL;
	const proxyBase = (env.CODEBASE_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE).replace(/\/+$/, "");

	// No provider + no model → "Codebase Auto" (the routed default).
	// No provider + an explicit model id → synthesize an openai-compat model
	// against that id. Pi-ai dispatches by `model.id` in the request body;
	// the proxy's model registry is the gatekeeper for what actually exists.
	if (!explicitProvider) {
		const template = getModel("groq", "llama-3.3-70b-versatile") as Model<string> | undefined;
		if (!template) return null;
		const isDefault = !explicitModel;
		const model: Model<string> = {
			...template,
			id: explicitModel ?? "MiniMax-M2.7",
			name: isDefault ? "Codebase Auto" : (explicitModel ?? "Codebase Auto"),
			baseUrl: proxyBase,
			// Override provider so the status bar and /model don't lie about
			// where this is served from. pi-ai uses `provider` mainly for
			// display + a few baseUrl heuristics; the request body sends
			// `model.id` only, so this cast is safe.
			provider: "codebase" as Model<string>["provider"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		return { model, apiKey: accessToken, source: "proxy" };
	}

	const modelId = explicitModel ?? DEFAULT_MODELS[explicitProvider];
	if (!modelId) return null;
	const baseModel = getModel(explicitProvider, modelId as never) as Model<string> | undefined;
	if (baseModel) {
		const proxiedModel: Model<string> = { ...baseModel, baseUrl: proxyBase };
		return { model: proxiedModel, apiKey: accessToken, source: "proxy" };
	}
	// pi-ai's registry doesn't know this provider+modelId combo (common for
	// backend-only models the proxy exposes, e.g. "codebase:MiniMax-M2.7"
	// or custom in-house ids). The proxy speaks openai-completions for
	// every upstream, so synthesizing an openai-compat model from a known
	// template + the user's chosen id works regardless of whether pi-ai
	// recognizes it locally. Without this fallback, /model would silently
	// revert to Codebase Auto whenever the user picked anything pi-ai
	// didn't have native cost / context-window data for.
	const template = getModel("groq", "llama-3.3-70b-versatile") as Model<string> | undefined;
	if (!template) return null;
	const synthesized: Model<string> = {
		...template,
		id: modelId,
		name: modelId,
		baseUrl: proxyBase,
		provider: explicitProvider as Model<string>["provider"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return { model: synthesized, apiKey: accessToken, source: "proxy" };
}

/**
 * OpenAI Chat-Completions compatible custom endpoint. Used by
 * MiniMax in-house, Qwen in-house, Groq custom URLs, Ollama, vLLM,
 * any tinybox running a Chat Completions server. Synthesizes a
 * Model<"openai-completions"> by cloning a known model from the
 * registry and overriding the id + baseUrl. Cost is unknown so we
 * zero it — /cost will report $0 for these runs, which is honest
 * (we don't know the rate) rather than wrong.
 */
function buildOpenAiCompatConfig(opts: { baseUrl: string; modelId: string; apiKey: string }): ResolvedConfig | null {
	// groq's llama-3.3-70b-versatile uses "openai-completions" — the
	// closest match for what MiniMax / Qwen in-house actually serve.
	const template = getModel("groq", "llama-3.3-70b-versatile") as Model<string> | undefined;
	if (!template) return null;
	const model: Model<string> = {
		...template,
		id: opts.modelId,
		name: opts.modelId,
		baseUrl: opts.baseUrl.replace(/\/+$/, ""),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return { model, apiKey: opts.apiKey, source: "explicit" };
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
