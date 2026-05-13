import { completeSimple, getModel, type KnownProvider, type Model } from "@earendil-works/pi-ai";

/**
 * Cheap-model sidecar. The agent's main model handles tool-using work;
 * GlueClient runs the meta-tasks that need an LLM but don't need
 * Opus-class reasoning: intent classification, narration, title
 * generation, follow-up suggestions.
 *
 * Two model slots:
 *   - fast: for frequent, latency-sensitive calls (intent classification,
 *     greetings detection). Should be the cheapest model that gives
 *     usable results — Haiku, Llama 3.1 8b, gpt-4o-mini.
 *   - smart: for occasional, quality-sensitive calls (plan generation,
 *     plan revision). Should be a small-to-mid model — Sonnet, gpt-4o.
 *
 * Both default to the parent agent's model when unset.
 */
export interface GlueOptions {
	fastModel: Model<string>;
	smartModel: Model<string>;
	/**
	 * Resolves the API key for each call. Async so callers can layer
	 * OAuth refresh-on-demand: when the underlying access token is near
	 * expiry, the getter swaps in a new one transparently.
	 */
	getApiKey: () => Promise<string> | string;
	/** Default 8000 — glue calls cap their reply length so a runaway summary doesn't hang the UI. */
	maxTokens?: number;
}

export class GlueClient {
	constructor(private readonly options: GlueOptions) {}

	fast(prompt: string, system?: string, signal?: AbortSignal): Promise<string> {
		return this.complete(this.options.fastModel, prompt, system, signal);
	}

	smart(prompt: string, system?: string, signal?: AbortSignal): Promise<string> {
		return this.complete(this.options.smartModel, prompt, system, signal);
	}

	private async complete(
		model: Model<string>,
		prompt: string,
		system: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const apiKey = await this.options.getApiKey();
		const message = await completeSimple(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				signal,
				maxTokens: this.options.maxTokens ?? 8000,
			},
		);
		return message.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");
	}
}

/**
 * Default glue model selection from env, falling back to the parent
 * agent's model. Both env vars take "provider:modelId" form so users
 * can mix providers (cheap Haiku for fast, Sonnet for smart).
 */
export interface ResolveGlueOptions {
	parentModel: Model<string>;
	parentApiKey: string;
	env?: NodeJS.ProcessEnv;
}

export function resolveGlueModels(opts: ResolveGlueOptions): {
	fast: Model<string>;
	smart: Model<string>;
	apiKey: string;
} {
	const env = opts.env ?? process.env;
	const fast = env.GLUE_FAST_MODEL ? parseGlueRef(env.GLUE_FAST_MODEL, opts.parentModel) : opts.parentModel;
	const smart = env.GLUE_SMART_MODEL ? parseGlueRef(env.GLUE_SMART_MODEL, opts.parentModel) : opts.parentModel;
	return { fast, smart, apiKey: opts.parentApiKey };
}

/**
 * Accept either a "modelId" (resolved against the parent provider) or
 * "provider:modelId" (cross-provider). Falls back to the parent on any
 * lookup miss so a typo doesn't kill the agent.
 */
export function parseGlueRef(ref: string, fallback: Model<string>): Model<string> {
	const trimmed = ref.trim();
	if (!trimmed) return fallback;

	const [maybeProvider, maybeId] = trimmed.includes(":") ? trimmed.split(":", 2) : [fallback.provider, trimmed];
	const found = getModel(maybeProvider as KnownProvider, maybeId as never);
	if (found) return found as Model<string>;
	// Lookup miss — typo or unknown model. Falling back is correct, but
	// silent fallback meant users who set GLUE_SMART_MODEL=foo-typo
	// thought they were getting their smart model and were actually
	// getting the parent. Make it visible under CODEBASE_DEBUG=1.
	if (process.env.CODEBASE_DEBUG === "1") {
		process.stderr.write(
			`[glue] no model matched "${trimmed}" — falling back to ${fallback.provider}/${fallback.id}\n`,
		);
	}
	return fallback;
}
