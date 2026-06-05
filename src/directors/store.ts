import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Autonomy, Director } from "./types.js";

const AUTONOMY_LEVELS: readonly Autonomy[] = ["cautious", "balanced", "autonomous"];

/** Turn a free-form title into a filesystem-/@handle-safe slug. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/director of\s+/, "") // "Director of Marketing" -> "marketing"
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "director";
}

/**
 * The autonomy → permission-gate mapping. This is where "rope" becomes
 * concrete safety: the PermissionStore we configure from this is what
 * lets you walk away. cautious never auto-runs anything mutating;
 * balanced/autonomous auto-run routine work, but the gate still blocks
 * irreversible ops unless they're in the director's trusted allow-list.
 */
export function permissionConfigFor(director: Director): {
	autoApprove: boolean;
	allowPatterns: readonly string[];
} {
	return {
		autoApprove: director.autonomy !== "cautious",
		allowPatterns: director.trusts,
	};
}

/**
 * System-prompt section for the active director. Mirrors
 * buildProjectFilesAddendum — appended to the base system prompt so the
 * agent takes on the director's role, mandate, and handbook.
 */
export function buildDirectorAddendum(director: Director): string {
	const head = `\n\n# You are the ${director.name}\n\n`;
	const mandate = `Your mandate: ${director.mandate}\n\n`;
	const handbook = director.handbook.trim() ? `${director.handbook.trim()}\n\n` : "";
	const boundary =
		`Autonomy: ${director.autonomy}. Act decisively on routine work yourself; ` +
		"irreversible operations (deploy, delete, push, spend) are gated and require " +
		"explicit authorization, so you never need to hesitate within that boundary.\n";
	return `${head}${mandate}${handbook}${boundary}`;
}

function splitFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	if (!raw.startsWith("---")) return { fm: {}, body: raw.trim() };
	const end = raw.indexOf("\n---", 3);
	if (end < 0) return { fm: {}, body: raw.trim() };
	const block = raw.slice(3, end);
	const body = raw
		.slice(end + 4)
		.replace(/^\r?\n/, "")
		.trim();
	const fm: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const i = line.indexOf(":");
		if (i < 0) continue;
		fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fm, body };
}

function parseList(value: string | undefined): string[] {
	const inner = (value ?? "")
		.trim()
		.replace(/^\[|\]$/g, "")
		.trim();
	if (!inner) return [];
	return inner
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function asAutonomy(value: string | undefined): Autonomy {
	return AUTONOMY_LEVELS.includes(value as Autonomy) ? (value as Autonomy) : "balanced";
}

function serialize(director: Director): string {
	return (
		"---\n" +
		`name: ${director.name}\n` +
		`mandate: ${director.mandate}\n` +
		`autonomy: ${director.autonomy}\n` +
		`trusts: [${director.trusts.join(", ")}]\n` +
		`---\n\n${director.handbook.trim()}\n`
	);
}

/**
 * Add a trusted op pattern to a director (deduped). Pure. This is how a
 * director "earns" an op during a shadow session — you trust it once, it
 * stops asking. Patterns are permission allow-patterns (e.g. "shell",
 * "write_file", or "shell:git push origin marketing*").
 */
export function trustOp(director: Director, pattern: string): Director {
	if (director.trusts.includes(pattern)) return director;
	return { ...director, trusts: [...director.trusts, pattern] };
}

/**
 * Persists directors as markdown files under ~/.codebase/directors/.
 * Markdown so the "employee handbook" stays human-readable and editable.
 */
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
			.filter((d): d is Director => d !== null);
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

	/**
	 * Load → add a trusted op → save. Trusting an op during a shadow session
	 * persists here so the director keeps the trust across sessions (the
	 * capture step of honing). Returns the updated director, or null if it no
	 * longer exists.
	 */
	trust(slug: string, pattern: string): Director | null {
		const director = this.load(slug);
		if (!director) return null;
		const updated = trustOp(director, pattern);
		this.save(updated);
		return updated;
	}
}
