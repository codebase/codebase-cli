import { loadOutputStyles } from "../../config/output-styles.js";
import { ConfigStore } from "../../config/store.js";
import type { Command } from "../types.js";

/**
 * /output-style — list, set, or clear the active response style.
 *
 * Styles are Markdown files in ~/.codebase/output-styles/ (or the
 * project's .codebase/output-styles/) whose body is appended to the
 * system prompt to reshape how the agent writes its answers.
 *
 * Setting a style persists it to config and rebuilds the agent so it
 * takes effect immediately while keeping the conversation. The rebuild
 * preserves the active model (via the persisted model preference, or
 * the proxy default).
 */
export const outputStyleCmd: Command = {
	name: "output-style",
	aliases: ["style"],
	description: "Show, set, or clear the response style (from ~/.codebase/output-styles/*.md).",
	handler: async (args, ctx) => {
		const arg = args.trim();
		const config = new ConfigStore({ cwd: ctx.bundle.toolContext.cwd });
		const styles = loadOutputStyles({ cwd: ctx.bundle.toolContext.cwd });
		const active = config.outputStyle();

		// No args → list available styles + which is active.
		if (!arg) {
			if (styles.length === 0) {
				ctx.emit("No output styles found.");
				ctx.emit("Create one at ~/.codebase/output-styles/<name>.md with a Markdown body, e.g.:");
				ctx.emit("  ---");
				ctx.emit("  name: Terse");
				ctx.emit("  description: One-liners, no preamble.");
				ctx.emit("  ---");
				ctx.emit("  Answer in as few words as possible.");
				return { handled: true };
			}
			ctx.emit("Output styles (* = active):");
			for (const s of styles) {
				const marker = s.id === active ? "*" : " ";
				ctx.emit(`  ${marker} ${s.id}${s.description ? `  · ${s.description}` : ""}`);
			}
			ctx.emit(active ? `Clear with /output-style off.` : "Set with /output-style <id>.");
			return { handled: true };
		}

		// Clear.
		if (arg === "off" || arg === "none" || arg === "clear" || arg === "default") {
			if (!active) {
				ctx.emit("No output style is active.");
				return { handled: true };
			}
			config.setOutputStyle(null);
			await rebuild(ctx, config);
			ctx.emit("Output style cleared.");
			return { handled: true };
		}

		// Set.
		const want = arg.toLowerCase();
		const match = styles.find((s) => s.id === want);
		if (!match) {
			ctx.emit(`No output style named "${arg}".`);
			if (styles.length > 0) ctx.emit(`Available: ${styles.map((s) => s.id).join(", ")}`);
			return { handled: true };
		}
		config.setOutputStyle(match.id);
		await rebuild(ctx, config);
		ctx.emit(`Output style set to "${match.id}"${match.description ? ` — ${match.description}` : ""}.`);
		return { handled: true };
	},
};

/**
 * Rebuild the agent so the new system prompt (with/without the style)
 * takes effect now, preserving the conversation. Re-applies the model
 * the user was already on: the persisted preference if any, else the
 * proxy default (null).
 */
async function rebuild(ctx: Parameters<typeof outputStyleCmd.handler>[1], config: ConfigStore): Promise<void> {
	const preferred = config.preferredModel();
	const spec = preferred?.modelId ? { provider: preferred.provider, modelId: preferred.modelId } : null;
	await ctx.switchModel(spec);
}
