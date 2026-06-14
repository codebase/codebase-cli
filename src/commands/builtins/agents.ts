import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "../types.js";

/**
 * /agents — list available subagent types (built-in + custom) and how to
 * define new ones. The agent picks from these via dispatch_agent's
 * agent_type parameter.
 */
export const agents: Command = {
	name: "agents",
	description: "List subagent types available to dispatch_agent.",
	handler: (_args, ctx) => {
		const types = ctx.bundle.toolContext.subagentTypes ?? [];
		ctx.emit("Subagent types:");
		for (const t of types) {
			const desc = t.description ? ` — ${t.description}` : "";
			const extras = [
				t.model ? `model ${t.model}` : null,
				t.effort ? `effort ${t.effort}` : null,
				t.maxTurns ? `${t.maxTurns} turns` : null,
			].filter(Boolean);
			const extraStr = extras.length ? `, ${extras.join(", ")}` : "";
			ctx.emit(`  ${t.name}${desc} (${t.source}, ${t.tools.length} tools${extraStr})`);
		}
		ctx.emit(
			`Define custom types as markdown in ${join(homedir(), ".codebase", "agents")}/<name>.md ` +
				"(or <project>/.codebase/agents/): frontmatter `description:`, `tools:`, optional " +
				"`model:` / `effort:` / `max_turns:`; body = role prompt.",
		);
		return { handled: true };
	},
};
