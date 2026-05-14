import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../types.js";

// ─── project + extensions ─────────────────────────────────────────────

export const init: Command = {
	name: "init",
	description: "Drop a starter CLAUDE.md at the project root with instructions for the agent.",
	mutates: true,
	handler: (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		const target = join(cwd, "CLAUDE.md");
		if (existsSync(target)) {
			ctx.emit(`CLAUDE.md already exists at ${target}. Edit it directly; it's auto-injected on session start.`);
			return { handled: true };
		}
		const template = [
			"# Project Instructions",
			"",
			"This file is auto-loaded by `codebase` on session start.",
			"Use it to capture project-specific rules and context the agent should follow.",
			"",
			"## What this project is",
			"",
			"Replace this with a one-paragraph summary of what the codebase does, the",
			"primary language(s), and the user-visible product.",
			"",
			"## Commands",
			"",
			"- Build:  `…`",
			"- Test:   `…`",
			"- Lint:   `…`",
			"",
			"## Coding conventions",
			"",
			"- …",
			"",
			"## Don'ts",
			"",
			"- …",
			"",
		].join("\n");
		writeFileSync(target, template);
		ctx.emit(`wrote ${target}. Edit it to capture project-specific guidance for the agent.`);
		return { handled: true };
	},
};
