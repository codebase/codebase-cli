import type { Command } from "../types.js";

/**
 * Friendly short-name → "<provider>:<modelId>" map. Lets a user type
 * `/model sonnet` instead of `/model anthropic:claude-sonnet-4-5`. The
 * actual provider availability still depends on the user's account /
 * BYOK keys; aliases just shorten the path for the common cases.
 */
const MODEL_ALIASES: Record<string, string> = {
	auto: "auto", // sentinel; resolved to null override in the handler
	sonnet: "anthropic:claude-sonnet-4-5",
	opus: "anthropic:claude-opus-4-1",
	haiku: "anthropic:claude-haiku-4-5",
	"gpt-5": "openai:gpt-5",
	"gpt-4": "openai:gpt-4o",
	"gpt-4o": "openai:gpt-4o",
	llama: "groq:llama-3.3-70b-versatile",
	"llama-3.3": "groq:llama-3.3-70b-versatile",
};

/** Parse `<provider>:<modelId>` or `<modelId>` or an alias into a model spec. */
function parseModelSpec(raw: string): { provider?: string; modelId: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower === "auto" || lower === "default" || lower === "reset") return null; // signal: reset
	const aliased = MODEL_ALIASES[lower];
	const target = aliased && aliased !== "auto" ? aliased : trimmed;
	const colonIdx = target.indexOf(":");
	if (colonIdx === -1) return { modelId: target };
	return { provider: target.slice(0, colonIdx).trim(), modelId: target.slice(colonIdx + 1).trim() };
}

export const modelCmd: Command = {
	name: "model",
	description: "Show or switch the active model. `/model <id>` or `/model <provider>:<id>` to switch.",
	handler: async (args, ctx) => {
		const arg = args.trim();
		if (!arg) {
			// No-args opens the inline picker. For BYOK / non-proxy sessions
			// there's no live model list to fetch, so print the static info
			// instead of an empty overlay.
			if (ctx.bundle.source !== "proxy") {
				const m = ctx.state.model;
				ctx.emit(`Current model: ${m.name} (${m.provider}/${m.id})`);
				ctx.emit("BYOK session — switch via CODEBASE_PROVIDER + CODEBASE_MODEL env vars at launch.");
				return { handled: true };
			}
			ctx.openModelPicker();
			return { handled: true };
		}
		if (arg === "--help" || arg === "-h") {
			ctx.emit("Usage:");
			ctx.emit("  /model              show the active model");
			ctx.emit("  /model <id>         switch (e.g. /model claude-sonnet-4-5)");
			ctx.emit("  /model <prov>:<id>  switch with explicit provider (e.g. /model anthropic:claude-sonnet-4-5)");
			ctx.emit("  /model auto         reset to the default (Codebase Auto for proxy users)");
			ctx.emit("  /model sonnet|opus|haiku|gpt-5|llama  aliases for common picks");
			return { handled: true };
		}
		const spec = parseModelSpec(arg);
		await ctx.switchModel(spec);
		return { handled: true };
	},
};

export const modelsCmd: Command = {
	name: "models",
	aliases: ["lm"],
	description: "List models available to your account (fetched live from the proxy).",
	handler: async (_args, ctx) => {
		// BYOK users don't go through our proxy — there's no central
		// "available models" endpoint for arbitrary upstreams. Tell them
		// how to switch and bail.
		if (ctx.bundle.source !== "proxy") {
			ctx.emit(`Current: ${ctx.state.model.name} (${ctx.state.model.provider}/${ctx.state.model.id})`);
			ctx.emit("BYOK session — switch by re-launching with CODEBASE_PROVIDER + CODEBASE_MODEL env vars.");
			return { handled: true };
		}
		const baseUrl = (ctx.bundle.model.baseUrl ?? "").replace(/\/+$/, "");
		if (!baseUrl) {
			ctx.emit("(model has no baseUrl — can't query the proxy)");
			return { handled: true };
		}
		try {
			const apiKey = await ctx.bundle.agent.getApiKey?.(ctx.bundle.model.provider);
			if (!apiKey) {
				ctx.emit("(not signed in — run `codebase auth login`)");
				return { handled: true };
			}
			const res = await fetch(`${baseUrl}/models`, {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			});
			if (!res.ok) {
				ctx.emit(`(failed to fetch models: ${res.status} ${res.statusText})`);
				return { handled: true };
			}
			const json = (await res.json()) as { models?: Array<{ id: string; name: string; provider: string }> };
			const models = json.models ?? [];
			if (models.length === 0) {
				ctx.emit("(no models returned)");
				return { handled: true };
			}
			const current = `${ctx.state.model.provider}/${ctx.state.model.id}`;
			ctx.emit("Available models (* = active):");
			// Group by provider so the list reads as a tree.
			const byProvider = new Map<string, Array<{ id: string; name: string }>>();
			for (const m of models) {
				const arr = byProvider.get(m.provider) ?? [];
				arr.push({ id: m.id, name: m.name });
				byProvider.set(m.provider, arr);
			}
			const providers = [...byProvider.keys()].sort();
			for (const p of providers) {
				ctx.emit(`  ${p}:`);
				for (const m of byProvider.get(p) ?? []) {
					const marker = `${p}/${m.id}` === current ? "*" : " ";
					ctx.emit(`    ${marker} ${m.id}  ${m.name === m.id ? "" : `· ${m.name}`}`);
				}
			}
			ctx.emit("Switch: /model <id> · /model <provider>:<id>");
		} catch (err) {
			ctx.emit(`(error fetching models: ${err instanceof Error ? err.message : String(err)})`);
		}
		return { handled: true };
	},
};
