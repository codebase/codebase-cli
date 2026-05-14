import type { Command } from "../types.js";

// ─── memory + context ─────────────────────────────────────────────────

export const memory: Command = {
	name: "memory",
	description: "Show the MEMORY.md index of saved cross-session memories for this project.",
	handler: (_args, ctx) => {
		const index = ctx.bundle.memory.index();
		if (!index.trim()) {
			ctx.emit("no memories saved yet. The agent can write them via the save_memory tool.");
			return { handled: true };
		}
		ctx.emit(index);
		return { handled: true };
	},
};
