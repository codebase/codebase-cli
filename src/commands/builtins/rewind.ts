import type { Command } from "../types.js";

/**
 * /rewind — restore files to their state before a prior agent edit.
 *
 * No args: list this session's rewind points (every file mutation, newest
 * first). With a checkpoint number: restore every file touched at or after
 * that point to its pre-image — overwritten files get their old bytes
 * back, files the agent created are deleted. Conversation history is NOT
 * rewound; the next message should tell the agent what was restored.
 */
export const rewind: Command = {
	name: "rewind",
	aliases: ["checkpoint"],
	description: "Restore files to their state before a prior agent edit. /rewind <n> applies.",
	mutates: true,
	handler: (args, ctx) => {
		const store = ctx.bundle.checkpoints;
		const entries = store.list();

		if (!args.trim()) {
			if (entries.length === 0) {
				ctx.emit("No rewind points yet — they're recorded every time the agent edits a file.");
				return { handled: true };
			}
			ctx.emit("Rewind points (newest first):");
			for (const e of [...entries].reverse().slice(0, 20)) {
				const time = new Date(e.timestamp).toLocaleTimeString();
				const created = e.existed ? "" : " (created)";
				ctx.emit(`  #${e.seq}  ${time}  ${e.tool}  ${e.display}${created}`);
			}
			if (entries.length > 20) ctx.emit(`  … and ${entries.length - 20} older`);
			ctx.emit("Run /rewind <n> to restore files to just before checkpoint #n.");
			return { handled: true };
		}

		const seq = Number.parseInt(args.trim(), 10);
		if (!Number.isInteger(seq) || !entries.some((e) => e.seq === seq)) {
			ctx.emit(`No checkpoint #${args.trim()}. Run /rewind to list valid points.`);
			return { handled: true };
		}

		const result = store.rewindTo(seq);
		for (const file of [...result.restored, ...result.deleted]) {
			// Restored bytes no longer match the agent's cached read state;
			// drop the snapshot so the next edit re-reads instead of tripping
			// the concurrent-modification guard.
			ctx.bundle.toolContext.fileStateCache.invalidate(file.path);
		}
		for (const f of result.restored) ctx.emit(`  ↺ restored ${f.display}`);
		for (const f of result.deleted) ctx.emit(`  ✕ deleted ${f.display} (didn't exist before)`);
		for (const f of result.skipped) ctx.emit(`  ⚠ could not restore ${f.display}`);
		if (result.restored.length + result.deleted.length === 0 && result.skipped.length === 0) {
			ctx.emit("Nothing to restore.");
		} else {
			ctx.emit("Files restored. Conversation history is unchanged — tell the agent what you rewound.");
		}
		return { handled: true };
	},
};
