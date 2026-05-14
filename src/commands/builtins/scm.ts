import { execSync } from "node:child_process";
import type { Command } from "../types.js";

// ─── git surface ──────────────────────────────────────────────────────

export const diff: Command = {
	name: "diff",
	description: "Show the working-tree diff (`git diff` shortstat then full).",
	handler: (args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		const target = args.trim() || "HEAD";
		try {
			const stat = execSync(`git diff --stat ${target}`, { cwd, encoding: "utf8" }).trim();
			const full = execSync(`git diff ${target}`, { cwd, encoding: "utf8" });
			if (!stat && !full) {
				ctx.emit("no changes vs HEAD.");
				return { handled: true };
			}
			ctx.emit(`${stat}\n\n${full}`);
		} catch (err) {
			ctx.emit(`/diff failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

export const commit: Command = {
	name: "commit",
	description: "Generate a commit message for the current diff via the smart glue model. Does not commit.",
	handler: async (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		try {
			const diffText = execSync("git diff --staged", { cwd, encoding: "utf8" });
			if (!diffText.trim()) {
				ctx.emit("nothing staged. Run `git add <files>` first, then /commit.");
				return { handled: true };
			}
			const system =
				"You write Conventional Commits messages. Subject ≤72 chars, imperative mood. " +
				"Body 1–3 short lines explaining WHY, not WHAT. No bullet lists. No file inventory.";
			const message = await ctx.bundle.glue.smart(`Generate a commit message for this diff:\n\n${diffText}`, system);
			ctx.emit(
				`suggested commit message:\n\n${message.trim()}\n\nIf you like it: git commit -m "..." (with the subject above).`,
			);
		} catch (err) {
			ctx.emit(`/commit failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

export const review: Command = {
	name: "review",
	description: "Have the smart glue model review your uncommitted changes.",
	handler: async (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		try {
			const diffText = execSync("git diff HEAD", { cwd, encoding: "utf8" });
			if (!diffText.trim()) {
				ctx.emit("no changes to review (working tree matches HEAD).");
				return { handled: true };
			}
			const system =
				"You are a senior engineer doing a code review. Be concise and concrete. " +
				"Call out: bugs, missing edge cases, security issues, naming nits, simpler alternatives. " +
				"Skip praise. If the diff is clean, say so in one line.";
			const text = await ctx.bundle.glue.smart(`Review this diff:\n\n${diffText}`, system);
			ctx.emit(text.trim());
		} catch (err) {
			ctx.emit(`/review failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};
