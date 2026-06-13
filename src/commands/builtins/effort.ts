import { EFFORT_LEVELS, type Effort, resolveEffort } from "../../agent/effort.js";
import { ConfigStore } from "../../config/store.js";
import type { Command } from "../types.js";

/**
 * /effort — show or set the model's reasoning effort (off … xhigh).
 * Lower = faster + cheaper; higher = more deliberate. Mutates the live
 * agent so it takes effect next turn, and persists the choice. Models
 * without reasoning support ignore the level.
 */
export const effortCmd: Command = {
	name: "effort",
	description: `Set reasoning effort: ${EFFORT_LEVELS.join(" / ")}. Lower is faster, higher is more thorough.`,
	handler: (args, ctx) => {
		const arg = args.trim().toLowerCase();
		const current = ctx.bundle.agent.state.thinkingLevel ?? "off";

		if (!arg) {
			ctx.emit(`Reasoning effort: ${current}`);
			ctx.emit(`Levels: ${EFFORT_LEVELS.join(" · ")}. Set with /effort <level>.`);
			return { handled: true };
		}

		const level = resolveEffort(arg);
		if (!level) {
			ctx.emit(`Unknown effort "${arg}". Use one of: ${EFFORT_LEVELS.join(", ")}.`);
			return { handled: true };
		}

		ctx.bundle.agent.state.thinkingLevel = level as Effort;
		try {
			new ConfigStore({ cwd: ctx.bundle.toolContext.cwd }).setEffort(level);
		} catch {
			// Persistence is non-fatal; the live change still applies this session.
		}
		ctx.emit(`Reasoning effort set to ${level} (applies from the next turn).`);
		return { handled: true };
	},
};
