import type { Command, CommandContext, CommandResult } from "./types.js";

/**
 * Slash-command registry. Stable, name-keyed, with optional aliases.
 * App.tsx forwards every user input that starts with "/" through here;
 * unrecognized commands fall through to the agent so a stray `/` in a
 * code snippet doesn't get hijacked.
 */
export class CommandRegistry {
	private readonly commands: Map<string, Command> = new Map();

	register(command: Command): void {
		const names = [command.name, ...(command.aliases ?? [])];
		for (const name of names) {
			const normalized = normalize(name);
			if (this.commands.has(normalized)) {
				throw new Error(`command ${name} already registered`);
			}
			this.commands.set(normalized, command);
		}
	}

	registerAll(commands: readonly Command[]): void {
		for (const command of commands) this.register(command);
	}

	get(name: string): Command | undefined {
		return this.commands.get(normalize(name));
	}

	/** All registered commands, deduplicated by primary name. Sorted alphabetically. */
	list(): Command[] {
		const seen = new Set<string>();
		const out: Command[] = [];
		for (const cmd of this.commands.values()) {
			if (seen.has(cmd.name)) continue;
			seen.add(cmd.name);
			out.push(cmd);
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	/**
	 * Try to dispatch user input as a slash command. Returns
	 * { handled: false } if the input doesn't start with "/" or names an
	 * unknown command — caller should pass it on to the agent in either
	 * case.
	 */
	async dispatch(input: string, ctx: CommandContext): Promise<CommandResult> {
		if (!input.startsWith("/")) return { handled: false };
		const trimmed = input.slice(1).trim();
		if (!trimmed) return { handled: false };
		const splitIdx = trimmed.search(/\s/);
		const name = splitIdx === -1 ? trimmed : trimmed.slice(0, splitIdx);
		const args = splitIdx === -1 ? "" : trimmed.slice(splitIdx + 1).trim();

		const command = this.get(name);
		if (!command) {
			ctx.emit(`unknown command: /${name}. Try /help.`);
			return { handled: true };
		}
		return command.handler(args, ctx);
	}
}

function normalize(name: string): string {
	return name.replace(/^\/+/, "").trim().toLowerCase();
}
