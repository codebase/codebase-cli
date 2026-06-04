import { createInterface } from "node:readline/promises";
import { DirectorStore, slugify } from "./store.js";
import type { Autonomy, Director } from "./types.js";

const AUTONOMY: readonly Autonomy[] = ["cautious", "balanced", "autonomous"];

export interface HireAnswers {
	title: string;
	mandate: string;
	autonomy: Autonomy;
}

/** Build a fresh Director from interview answers. Pure — no disk, no I/O. */
export function directorFromAnswers(a: HireAnswers): Director {
	return {
		slug: slugify(a.title),
		name: a.title.trim(),
		mandate: a.mandate.trim(),
		autonomy: a.autonomy,
		trusts: [],
		handbook: starterHandbook(),
	};
}

/** The one-line "what it will/won't do on its own" — the confidence line. */
export function autonomyLine(d: Director): string {
	switch (d.autonomy) {
		case "cautious":
			return "Asks you before any change — maximum oversight.";
		case "autonomous":
			return d.trusts.length > 0
				? `Runs freely; still asks before irreversible ops outside its ${d.trusts.length} trusted one(s).`
				: "Runs freely; still asks before push · deploy · delete · spend.";
		default:
			return "Runs routine work on its own. Always asks before: push · deploy · delete · spend.";
	}
}

function starterHandbook(): string {
	return [
		"## Context",
		"<!-- Context is king. Add the company/product facts this director needs. -->",
		"",
		"## Voice & boundaries",
		"<!-- How should it communicate? What must it never do? -->",
	].join("\n");
}

interface HireFlags {
	title?: string;
	mandate?: string;
	autonomy?: Autonomy;
	error?: string;
}

function parseHireFlags(args: string[]): HireFlags {
	const out: HireFlags = {};
	for (let i = 0; i < args.length; i++) {
		const [flag, inlineValue] = splitFlag(args[i]);
		const value = inlineValue ?? args[++i];
		switch (flag) {
			case "--title":
				out.title = value;
				break;
			case "--owns":
			case "--mandate":
				out.mandate = value;
				break;
			case "--autonomy":
				if (!AUTONOMY.includes(value as Autonomy)) {
					return { error: `--autonomy must be one of: ${AUTONOMY.join(", ")}` };
				}
				out.autonomy = value as Autonomy;
				break;
			default:
				return { error: `unknown flag: ${flag}` };
		}
	}
	return out;
}

function splitFlag(arg: string): [string, string | undefined] {
	const eq = arg.indexOf("=");
	return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

async function interview(have: HireFlags): Promise<HireAnswers> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const title = have.title ?? (await rl.question("Title (e.g. Director of Marketing): ")).trim();
		const mandate = have.mandate ?? (await rl.question("What do they own? ")).trim();
		let autonomy = have.autonomy;
		if (!autonomy) {
			const raw = (await rl.question("Rope — cautious / balanced / autonomous [balanced]: ")).trim().toLowerCase();
			autonomy = AUTONOMY.includes(raw as Autonomy) ? (raw as Autonomy) : "balanced";
		}
		return { title, mandate, autonomy };
	} finally {
		rl.close();
	}
}

/** `codebase hire [--title .. --owns .. --autonomy ..]` — create a director. */
export async function runHireSubcommand(argv: string[]): Promise<number> {
	const flags = parseHireFlags(argv.slice(1));
	if (flags.error) {
		process.stderr.write(`${flags.error}\n`);
		return 2;
	}

	let answers: HireAnswers;
	if (flags.title && flags.mandate && flags.autonomy) {
		answers = { title: flags.title, mandate: flags.mandate, autonomy: flags.autonomy };
	} else if (process.stdin.isTTY) {
		answers = await interview(flags);
	} else {
		process.stderr.write("hire needs a terminal for the interview, or pass --title, --owns, and --autonomy\n");
		return 2;
	}

	if (!answers.title.trim()) {
		process.stderr.write("a title is required\n");
		return 2;
	}

	const director = directorFromAnswers(answers);
	const store = new DirectorStore();
	if (store.load(director.slug)) {
		process.stderr.write(`a director "@${director.slug}" already exists — fire it first, or pick another title\n`);
		return 1;
	}
	store.save(director);
	process.stdout.write(
		`✅ Hired ${director.name} (@${director.slug}).\n` +
			`   ${autonomyLine(director)}\n` +
			`   Put them to work:  codebase run --director ${director.slug} "<task>"\n`,
	);
	return 0;
}

/** `codebase directors` — list hired directors. */
export async function runDirectorsSubcommand(_argv: string[]): Promise<number> {
	const directors = new DirectorStore().list();
	if (directors.length === 0) {
		process.stdout.write("No directors yet. Hire one:  codebase hire\n");
		return 0;
	}
	for (const d of directors) {
		process.stdout.write(`@${d.slug}  —  ${d.name}: ${d.mandate}\n   ${autonomyLine(d)}\n`);
	}
	return 0;
}

/** `codebase fire <slug>` — remove a director. */
export async function runFireSubcommand(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) {
		process.stderr.write("usage: codebase fire <slug>\n");
		return 2;
	}
	if (!new DirectorStore().remove(slug)) {
		process.stderr.write(`no director "@${slug}"\n`);
		return 1;
	}
	process.stdout.write(`Fired @${slug}.\n`);
	return 0;
}
