import { createInterface } from "node:readline/promises";
import { DirectorStore, slugify } from "./store.js";
import type { Autonomy, Director } from "./types.js";

const AUTONOMY: readonly Autonomy[] = ["cautious", "balanced", "autonomous"];

export interface HireAnswers {
	title: string;
	mandate: string;
}

/**
 * Build a fresh director from interview answers. Pure — no disk, no I/O.
 * Every new hire starts in training ("cautious"); autonomy is EARNED by
 * shadowing it and then `codebase graduate`-ing it, never picked at hire.
 */
export function directorFromAnswers(a: HireAnswers): Director {
	return {
		slug: slugify(a.title),
		name: a.title.trim(),
		mandate: a.mandate.trim(),
		autonomy: "cautious",
		trusts: [],
		handbook: starterHandbook(),
	};
}

/** Move a director one rung UP the ladder: training → trusted → autonomous. */
export function promote(a: Autonomy): Autonomy {
	return AUTONOMY[Math.min(AUTONOMY.indexOf(a) + 1, AUTONOMY.length - 1)];
}

/** Move one rung DOWN — e.g. pull a director back into training. */
export function demote(a: Autonomy): Autonomy {
	return AUTONOMY[Math.max(AUTONOMY.indexOf(a) - 1, 0)];
}

/** The one-line "where it is in its lifecycle + what it'll do on its own". */
export function autonomyLine(d: Director): string {
	switch (d.autonomy) {
		case "cautious":
			return "In training — you approve every action while you shadow it. Graduate it when you trust it.";
		case "autonomous":
			return d.trusts.length > 0
				? `Unleashed; still asks before irreversible ops outside its ${d.trusts.length} trusted one(s).`
				: "Unleashed; still asks before push · deploy · delete · spend.";
		default:
			return "Graduated — runs routine work on its own. Always asks before: push · deploy · delete · spend.";
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
		return { title, mandate };
	} finally {
		rl.close();
	}
}

/** `codebase hire [--title .. --owns ..]` — create a director (starts in training). */
export async function runHireSubcommand(argv: string[]): Promise<number> {
	const flags = parseHireFlags(argv.slice(1));
	if (flags.error) {
		process.stderr.write(`${flags.error}\n`);
		return 2;
	}

	let answers: HireAnswers;
	if (flags.title && flags.mandate) {
		answers = { title: flags.title, mandate: flags.mandate };
	} else if (process.stdin.isTTY) {
		answers = await interview(flags);
	} else {
		process.stderr.write("hire needs a terminal for the interview, or pass --title and --owns\n");
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
		`✅ Hired ${director.name} (@${director.slug}) — in training.\n` +
			`   Shadow it:           codebase --director ${director.slug}\n` +
			`   When you trust it:   codebase graduate ${director.slug}\n`,
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

/** `codebase graduate <slug>` — move a director one rung up (unleash it). */
export async function runGraduateSubcommand(argv: string[]): Promise<number> {
	return moveStage(argv[1], "graduate", promote);
}

/** `codebase demote <slug>` — pull a director one rung down (toward training). */
export async function runDemoteSubcommand(argv: string[]): Promise<number> {
	return moveStage(argv[1], "demote", demote);
}

async function moveStage(
	slug: string | undefined,
	cmd: "graduate" | "demote",
	move: (a: Autonomy) => Autonomy,
): Promise<number> {
	if (!slug) {
		process.stderr.write(`usage: codebase ${cmd} <slug>\n`);
		return 2;
	}
	const store = new DirectorStore();
	const director = store.load(slug);
	if (!director) {
		process.stderr.write(`no director "@${slug}"\n`);
		return 1;
	}
	const next = move(director.autonomy);
	if (next === director.autonomy) {
		process.stderr.write(`@${slug} is already "${director.autonomy}" — can't ${cmd} further\n`);
		return 1;
	}
	store.save({ ...director, autonomy: next });
	process.stdout.write(
		`@${slug}: ${director.autonomy} → ${next}\n   ${autonomyLine({ ...director, autonomy: next })}\n`,
	);
	return 0;
}
