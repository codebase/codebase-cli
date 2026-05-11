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
			const suggestion = this.suggestClosest(name);
			ctx.emit(
				suggestion
					? `unknown command: /${name}. Did you mean /${suggestion}?`
					: `unknown command: /${name}. Try /help.`,
			);
			return { handled: true };
		}
		return command.handler(args, ctx);
	}

	/**
	 * Return the registered command name with the smallest edit distance
	 * to `query` when it's a likely typo (distance ≤ 2 or ≤ ceil(len/3),
	 * whichever is greater). Returns undefined when nothing's close
	 * enough — better to print "Try /help" than to mis-suggest.
	 */
	private suggestClosest(query: string): string | undefined {
		const q = normalize(query);
		if (!q) return undefined;
		const threshold = Math.max(2, Math.ceil(q.length / 3));
		let best: { name: string; dist: number } | undefined;
		for (const name of new Set(Array.from(this.commands.values()).map((c) => c.name))) {
			const dist = levenshtein(q, name);
			if (dist <= threshold && (!best || dist < best.dist)) {
				best = { name, dist };
			}
		}
		return best?.name;
	}
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev = new Array(b.length + 1);
	const curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}

function normalize(name: string): string {
	return name.replace(/^\/+/, "").trim().toLowerCase();
}
