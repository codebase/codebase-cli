import { fetchAvailableModels } from "../../agent/model-list.js";
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
			// No-args opens the inline picker — it fetches the live model list
			// from whatever this session talks to (proxy, an OpenAI-compatible /
			// local server, Anthropic, Google) and switches in place.
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
	description: "List the models this session can switch to (live from the proxy, provider API, or local server).",
	handler: async (_args, ctx) => {
		const apiKey = await ctx.bundle.agent.getApiKey?.(ctx.bundle.model.provider);
		let models: Array<{ id: string; name: string; provider: string }>;
		try {
			models = await fetchAvailableModels(ctx.bundle.model, apiKey);
		} catch (err) {
			ctx.emit(`(couldn't list models: ${err instanceof Error ? err.message : String(err)})`);
			ctx.emit(`Current: ${ctx.state.model.name} (${ctx.state.model.provider}/${ctx.state.model.id})`);
			return { handled: true };
		}
		if (models.length === 0) {
			ctx.emit(`(no models returned for ${ctx.bundle.model.provider})`);
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
		for (const p of [...byProvider.keys()].sort()) {
			ctx.emit(`  ${p}:`);
			for (const m of byProvider.get(p) ?? []) {
				const marker = `${p}/${m.id}` === current || m.id === ctx.state.model.id ? "*" : " ";
				ctx.emit(`    ${marker} ${m.id}${m.name === m.id ? "" : `  · ${m.name}`}`);
			}
		}
		ctx.emit("Switch: /model <id> · /model <provider>:<id> · or /model for the picker");
		return { handled: true };
	},
};
