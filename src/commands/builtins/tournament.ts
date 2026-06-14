import type { Command } from "../types.js";

/**
 * /tournament [n] <task> — race N agents (default 3, max 5) on the same
 * build task in isolated worktrees, then pick the winner to merge. The
 * heavy lifting (snapshot, worktrees, judge, merge UI) lives in the App
 * via ctx.runTournament; here we just parse and hand off.
 */
export const tournament: Command = {
	name: "tournament",
	aliases: ["race"],
	description: "Race N agents on a build task in parallel, then merge the winner. /tournament [n] <task>",
	mutates: true,
	handler: (args, ctx) => {
		if (!ctx.runTournament) {
			ctx.emit("/tournament needs the pi-tui UI (the default). It's not available in the legacy renderer.");
			return { handled: true };
		}
		const trimmed = args.trim();
		if (!trimmed) {
			ctx.emit(
				"Usage: /tournament [n] <what to build or change>  — e.g. /tournament 3 add pagination to the users list",
			);
			return { handled: true };
		}
		// Optional leading contestant count.
		let count = 3;
		let task = trimmed;
		const m = trimmed.match(/^(\d+)\s+(.*)$/s);
		if (m) {
			count = Math.min(5, Math.max(2, Number.parseInt(m[1], 10)));
			task = m[2].trim();
		}
		if (!task) {
			ctx.emit("Give the contestants something to build: /tournament <task>.");
			return { handled: true };
		}
		ctx.runTournament(task, count);
		return { handled: true };
	},
};
