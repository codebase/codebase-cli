import type { Command } from "../types.js";

const MAX_CONTESTANTS = 5;

/**
 * /tournament [n] <task> — race N agents (default 3, max 5) on the same
 * build task in isolated worktrees, then pick the winner to merge.
 * `--models a,b,c` runs one contestant per model id instead of N copies
 * of the current model. The heavy lifting (snapshot, worktrees, judge,
 * merge UI) lives in the App via ctx.runTournament; here we just parse.
 */
export const tournament: Command = {
	name: "tournament",
	aliases: ["race"],
	description: "Race agents on a build task, then merge the winner. /tournament [n|--models a,b,c] <task>",
	mutates: true,
	handler: (args, ctx) => {
		if (!ctx.runTournament) {
			ctx.emit("/tournament needs the pi-tui UI (the default). It's not available in the legacy renderer.");
			return { handled: true };
		}
		let rest = args.trim();
		if (!rest) {
			ctx.emit(
				"Usage: /tournament [n] <task>  or  /tournament --models a,b,c <task>\n" +
					"e.g. /tournament 3 add pagination · /tournament --models opus,sonnet,haiku fix the parser",
			);
			return { handled: true };
		}

		// Pull out an optional --models / --model flag from anywhere in the args.
		let models: string[] | undefined;
		const mm = rest.match(/--models?(?:=|\s+)(\S+)/);
		if (mm) {
			models = mm[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			rest = (rest.slice(0, mm.index) + rest.slice((mm.index ?? 0) + mm[0].length)).replace(/\s+/g, " ").trim();
			if (models.length < 2) {
				ctx.emit(
					"--models needs at least 2 model ids to race (or drop the flag for N copies of the current model).",
				);
				return { handled: true };
			}
			if (models.length > MAX_CONTESTANTS) {
				ctx.emit(`capping at ${MAX_CONTESTANTS} contestants; ignoring the extra models.`);
				models = models.slice(0, MAX_CONTESTANTS);
			}
		}

		// A leading count only applies when no explicit model list was given
		// (otherwise the contestant count is the number of models, and a
		// leading digit is part of the task — e.g. "2fa support").
		let count = models ? models.length : 3;
		let task = rest;
		if (!models) {
			const m = rest.match(/^(\d+)\s+(.*)$/s);
			if (m) {
				count = Math.min(MAX_CONTESTANTS, Math.max(2, Number.parseInt(m[1], 10)));
				task = m[2].trim();
			}
		}

		if (!task) {
			ctx.emit("Give the contestants something to build: /tournament <task>.");
			return { handled: true };
		}
		ctx.runTournament(task, { count, models });
		return { handled: true };
	},
};
