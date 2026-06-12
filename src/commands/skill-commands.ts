import type { SkillAsset } from "../skills/types.js";
import type { CommandRegistry } from "./registry.js";
import type { Command } from "./types.js";

/** Skill ids become slash commands; anything unsafe for that role is skipped. */
const VALID_ID = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Bridge loaded skills into slash commands: `/<skill-id> [args]` expands
 * the skill body into a user prompt and submits it to the agent. `$ARGUMENTS`
 * in the body is replaced with whatever follows the command; without the
 * placeholder, args are appended after the body. Built-in commands always
 * win — a skill whose id collides with one already registered is skipped
 * with a stderr note rather than shadowing it.
 */
export function buildSkillCommands(skills: readonly SkillAsset[], registry: CommandRegistry): Command[] {
	const out: Command[] = [];
	for (const skill of skills) {
		if (!VALID_ID.test(skill.id)) {
			process.stderr.write(`[skills] skipping "${skill.id}": id must match ${VALID_ID}.\n`);
			continue;
		}
		if (registry.get(skill.id)) {
			process.stderr.write(`[skills] skipping "${skill.id}": collides with a built-in command.\n`);
			continue;
		}
		out.push({
			name: skill.id,
			description: skill.description ? `${skill.description} (skill)` : `Run the ${skill.name} skill.`,
			handler: (args, ctx) => {
				if (ctx.state.status !== "idle" && ctx.state.status !== "error" && ctx.state.status !== "aborted") {
					ctx.emit(`agent is busy — run /${skill.id} after this turn settles.`);
					return { handled: true };
				}
				const prompt = expandSkillPrompt(skill.systemPrompt, args);
				if (!prompt.trim()) {
					ctx.emit(`skill "${skill.id}" has an empty body — nothing to run.`);
					return { handled: true };
				}
				// Fire-and-forget: the turn streams through bundle.subscribe like
				// any typed prompt; blocking dispatch until the turn settles would
				// freeze the input bar for the whole run.
				void ctx.bundle.submitUserPrompt(prompt).then((result) => {
					if (!result.submitted) ctx.emit(`skill blocked: ${result.reason ?? "refused by hook"}`);
					else if (result.error) ctx.emit(`agent error: ${result.error}`);
				});
				return { handled: true };
			},
		});
	}
	return out;
}

export function expandSkillPrompt(body: string, args: string): string {
	const trimmedArgs = args.trim();
	if (body.includes("$ARGUMENTS")) {
		return body.replaceAll("$ARGUMENTS", trimmedArgs);
	}
	return trimmedArgs ? `${body.trim()}\n\n${trimmedArgs}` : body.trim();
}
