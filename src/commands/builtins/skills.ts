import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "../types.js";

/**
 * /skills — list every loaded skill with its provenance, or guidance on
 * creating one when none exist. Skills are markdown files that become
 * slash commands; see buildSkillCommands for the invocation bridge.
 */
export const skills: Command = {
	name: "skills",
	description: "List available skills (markdown prompts invocable as /<id>).",
	handler: async (_args, ctx) => {
		const loaded = await ctx.bundle.assets.listSkills();
		if (loaded.length === 0) {
			ctx.emit("No skills found.");
			ctx.emit(`Create one at ${join(homedir(), ".codebase", "skills")}/<id>.md (or <project>/.codebase/skills/):`);
			ctx.emit("  ---");
			ctx.emit("  description: Refactor the named file for performance.");
			ctx.emit("  ---");
			ctx.emit("  Profile and optimize $ARGUMENTS. Measure before and after.");
			ctx.emit("Then invoke it as /<id> [arguments]. Restart codebase to pick up new files.");
			return { handled: true };
		}
		ctx.emit("Skills:");
		for (const s of [...loaded].sort((a, b) => a.id.localeCompare(b.id))) {
			const desc = s.description ? ` — ${s.description}` : "";
			ctx.emit(`  /${s.id}${desc} (${s.source})`);
		}
		return { handled: true };
	},
};
