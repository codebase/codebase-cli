import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTONOMY_LEVELS, type Autonomy, type Director } from "./types.js";

/** Free-form title → filesystem-/@handle-safe slug. "Director of Marketing" → "marketing". */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/director of\s+/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "director";
}

/**
 * Build a fresh director from a hire interview. Pure — no disk. Every new
 * hire starts `cautious`; autonomy is EARNED by shadowing + graduating,
 * never picked at hire.
 */
export function directorFromAnswers(a: { title: string; mandate: string }): Director {
	return {
		slug: slugify(a.title),
		name: a.title.trim(),
		mandate: a.mandate.trim(),
		autonomy: "cautious",
		trusts: [],
		handbook: starterHandbook(),
	};
}

/** Move one rung up the ladder (graduate). */
export function promote(a: Autonomy): Autonomy {
	return AUTONOMY_LEVELS[Math.min(AUTONOMY_LEVELS.indexOf(a) + 1, AUTONOMY_LEVELS.length - 1)];
}

/** Move one rung down (pull back toward training). */
export function demote(a: Autonomy): Autonomy {
	return AUTONOMY_LEVELS[Math.max(AUTONOMY_LEVELS.indexOf(a) - 1, 0)];
}

/** Add a trusted op pattern (deduped). Pure — how a director "earns" an op. */
export function trustOp(director: Director, pattern: string): Director {
	if (director.trusts.includes(pattern)) return director;
	return { ...director, trusts: [...director.trusts, pattern] };
}

/** One-line "where it is in its lifecycle + what it'll do on its own". */
export function autonomyLine(d: Director): string {
	switch (d.autonomy) {
		case "cautious":
			return "In training — you approve every action while you shadow it. Graduate it when the evidence is there.";
		case "autonomous":
			return d.trusts.length > 0
				? `Unleashed; still escalates irreversible ops outside its ${d.trusts.length} trusted one(s).`
				: "Unleashed; still escalates anything irreversible (push · deploy · delete · spend).";
		default:
			return "Graduated — runs reversible work on its own, escalates the irreversible (push · deploy · delete · spend).";
	}
}

/**
 * Autonomy → permission-gate config. `cautious` prompts on everything (the
 * shadow phase, where evidence is built); `balanced`/`autonomous` auto-run
 * reversible work — the reversibility gate still escalates the irreversible
 * unless it's in the director's earned `trusts` allow-list.
 */
export function permissionConfigFor(director: Director): { autoApprove: boolean; allowPatterns: readonly string[] } {
	return { autoApprove: director.autonomy !== "cautious", allowPatterns: director.trusts };
}

/**
 * System-prompt section for the active director. Appended to the base
 * prompt so the agent takes on the role. Deliberately frames the autonomy
 * boundary as "act on the reversible, surface the irreversible/uncertain" —
 * NOT "never hesitate" (that fights the escalation model).
 */
export function buildDirectorAddendum(director: Director): string {
	const handbook = director.handbook.trim() ? `${director.handbook.trim()}\n\n` : "";
	return (
		`\n\n# You are the ${director.name}\n\n` +
		`Your mandate: ${director.mandate}\n\n` +
		handbook +
		`Autonomy: ${director.autonomy}. Act decisively on reversible, routine work — you don't need to ask. ` +
		"But irreversible or genuinely uncertain actions are surfaced to the human for approval; when you're not " +
		"sure, say so plainly and ask rather than guessing. Reaching out at the right moment is part of the job.\n"
	);
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

// ─── persistence ─────────────────────────────────────────────

/** Persists directors as markdown (frontmatter + handbook) under ~/.codebase/directors/. */
export class DirectorStore {
	private readonly dir: string;

	constructor(opts: { baseDir?: string } = {}) {
		this.dir = opts.baseDir ?? join(homedir(), ".codebase", "directors");
	}

	list(): Director[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => this.load(f.slice(0, -3)))
			.filter((d): d is Director => d !== null)
			.sort((a, b) => a.slug.localeCompare(b.slug));
	}

	load(slug: string): Director | null {
		const path = join(this.dir, `${slug}.md`);
		if (!existsSync(path)) return null;
		const { fm, body } = splitFrontmatter(readFileSync(path, "utf8"));
		return {
			slug,
			name: fm.name || slug,
			mandate: fm.mandate ?? "",
			autonomy: asAutonomy(fm.autonomy),
			trusts: parseList(fm.trusts),
			handbook: body,
		};
	}

	save(director: Director): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, `${director.slug}.md`), serialize(director), "utf8");
	}

	remove(slug: string): boolean {
		const path = join(this.dir, `${slug}.md`);
		if (!existsSync(path)) return false;
		rmSync(path);
		return true;
	}

	/** Load → add a trusted op → save. The persist step of earning trust. */
	trust(slug: string, pattern: string): Director | null {
		const director = this.load(slug);
		if (!director) return null;
		const updated = trustOp(director, pattern);
		this.save(updated);
		return updated;
	}
}

function serialize(d: Director): string {
	return (
		"---\n" +
		`name: ${d.name}\n` +
		`mandate: ${d.mandate}\n` +
		`autonomy: ${d.autonomy}\n` +
		`trusts: [${d.trusts.join(", ")}]\n` +
		`---\n\n${d.handbook.trim()}\n`
	);
}

function splitFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	if (!raw.startsWith("---")) return { fm: {}, body: raw.trim() };
	const end = raw.indexOf("\n---", 3);
	if (end < 0) return { fm: {}, body: raw.trim() };
	const fm: Record<string, string> = {};
	for (const line of raw.slice(3, end).split("\n")) {
		const i = line.indexOf(":");
		if (i < 0) continue;
		fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const body = raw
		.slice(end + 4)
		.replace(/^\r?\n/, "")
		.trim();
	return { fm, body };
}

function parseList(value: string | undefined): string[] {
	const inner = (value ?? "")
		.trim()
		.replace(/^\[|\]$/g, "")
		.trim();
	return inner
		? inner
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

function asAutonomy(value: string | undefined): Autonomy {
	return AUTONOMY_LEVELS.includes(value as Autonomy) ? (value as Autonomy) : "balanced";
}
