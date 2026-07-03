import { createInterface } from "node:readline/promises";
import { ActivityLog, agreementRate } from "./activity.js";
import { autonomyLine, DirectorStore, directorFromAnswers } from "./store.js";

export interface DirectorCliDeps {
	store?: DirectorStore;
	cwd?: string;
	/** Override the data root (tests). */
	dataRoot?: string;
	out?: (s: string) => void;
	err?: (s: string) => void;
}

/**
 * `codebase director <hire|list|status|fire>` — manage directors before a
 * session. (Running a session AS a director is `codebase --director <slug>`,
 * wired in a later phase.)
 */
export async function runDirectorSubcommand(argv: string[], deps: DirectorCliDeps = {}): Promise<number> {
	const out = deps.out ?? ((s) => process.stdout.write(s));
	const err = deps.err ?? ((s) => process.stderr.write(s));
	const store = deps.store ?? new DirectorStore({ baseDir: deps.dataRoot ? `${deps.dataRoot}/directors` : undefined });
	const sub = argv[1];

	switch (sub) {
		case "hire":
			return hire(argv.slice(2), store, out, err);
		case "list":
		case undefined:
			return list(store, out);
		case "status":
			return status(argv[2], store, out, err, deps);
		case "fire":
			return fire(argv[2], store, out, err);
		default:
			err(`unknown director command "${sub}" — try: hire | list | status <slug> | fire <slug>\n`);
			return 2;
	}
}

async function hire(
	args: string[],
	store: DirectorStore,
	out: (s: string) => void,
	err: (s: string) => void,
): Promise<number> {
	const flags = parseFlags(args);
	if (flags.error) {
		err(`${flags.error}\n`);
		return 2;
	}

	let title = flags.title;
	let mandate = flags.mandate;
	if (!title || !mandate) {
		if (!process.stdin.isTTY) {
			err("hire needs a terminal for the interview, or pass --title and --owns\n");
			return 2;
		}
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			title ??= (await rl.question("Title (e.g. Director of Marketing): ")).trim();
			mandate ??= (await rl.question("What do they own? ")).trim();
		} finally {
			rl.close();
		}
	}

	if (!title?.trim()) {
		err("a title is required\n");
		return 2;
	}

	const director = directorFromAnswers({ title, mandate: mandate ?? "" });
	if (store.load(director.slug)) {
		err(`a director "@${director.slug}" already exists — fire it first, or pick another title\n`);
		return 1;
	}
	store.save(director);
	out(
		`✅ Hired ${director.name} (@${director.slug}) — in training.\n` +
			`   Shadow it:   codebase --director ${director.slug}\n` +
			`   Check on it:  codebase director status ${director.slug}\n`,
	);
	return 0;
}

function list(store: DirectorStore, out: (s: string) => void): number {
	const directors = store.list();
	if (directors.length === 0) {
		out("No directors yet. Hire one:  codebase director hire\n");
		return 0;
	}
	for (const d of directors) {
		out(`@${d.slug}  —  ${d.name}: ${d.mandate}\n   ${autonomyLine(d)}\n`);
	}
	return 0;
}

function status(
	slug: string | undefined,
	store: DirectorStore,
	out: (s: string) => void,
	err: (s: string) => void,
	deps: DirectorCliDeps,
): number {
	if (!slug) {
		err("usage: codebase director status <slug>\n");
		return 2;
	}
	const d = store.load(slug);
	if (!d) {
		err(`no director "@${slug}"\n`);
		return 1;
	}
	const s = new ActivityLog({ cwd: deps.cwd ?? process.cwd(), slug, dataRoot: deps.dataRoot }).stats();
	out(`@${d.slug}  ${d.name}\n  ${d.mandate}\n  ${autonomyLine(d)}\n`);
	if (s.total === 0) {
		out("  No activity on this project yet — shadow it to build a track record.\n");
		return 0;
	}
	out(
		`\n  Track record (this project):\n` +
			`    ${s.total} actions · ${s.autoApproved} auto · ${s.escalated} escalated · ${s.approved} approved · ${s.denied} denied\n`,
	);
	if (s.deniedIrreversible > 0) {
		out(`    ⚠ ${s.deniedIrreversible} denied irreversible action(s) — blocks graduation.\n`);
	}
	const families = Object.entries(s.byFamily).sort((a, b) => b[1].proposed - a[1].proposed);
	if (families.length > 0) {
		out("    By command family (your agreement with its proposals):\n");
		for (const [fam, f] of families) {
			const rate = agreementRate(f);
			const pct = rate === null ? "—" : `${Math.round(rate * 100)}%`;
			out(`      ${fam.padEnd(18)} ${f.approved}/${f.proposed} (${pct})\n`);
		}
	}
	return 0;
}

function fire(
	slug: string | undefined,
	store: DirectorStore,
	out: (s: string) => void,
	err: (s: string) => void,
): number {
	if (!slug) {
		err("usage: codebase director fire <slug>\n");
		return 2;
	}
	if (!store.remove(slug)) {
		err(`no director "@${slug}"\n`);
		return 1;
	}
	out(`Fired @${slug}.\n`);
	return 0;
}

interface Flags {
	title?: string;
	mandate?: string;
	error?: string;
}

function parseFlags(args: string[]): Flags {
	const out: Flags = {};
	for (let i = 0; i < args.length; i++) {
		const eq = args[i].indexOf("=");
		const flag = eq < 0 ? args[i] : args[i].slice(0, eq);
		const value = eq < 0 ? args[++i] : args[i].slice(eq + 1);
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
