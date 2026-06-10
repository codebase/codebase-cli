import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMarkdownWithFrontmatter, strOrUndef } from "./frontmatter.js";

/**
 * An output style reshapes how the agent writes its user-facing
 * responses (terse, explanatory, report-mode, …) by appending a body
 * of instructions to the system prompt. Loaded from Markdown files:
 *
 *   ~/.codebase/output-styles/<name>.md      (user)
 *   <cwd>/.codebase/output-styles/<name>.md  (project, wins on id clash)
 *
 *   ---
 *   name: Terse
 *   description: One-liners. No preamble.
 *   ---
 *   Answer in as few words as possible. Skip restating the question.
 *   Never add a summary section.
 *
 * Project styles override user styles with the same id so a repo can
 * pin its house voice.
 */
export interface OutputStyle {
	/** Stable id — the filename without `.md`, lowercased. Used by /output-style. */
	id: string;
	/** Display name from frontmatter, or the id if omitted. */
	name: string;
	/** One-line description for the picker. */
	description: string;
	/** The instruction body appended to the system prompt when active. */
	body: string;
}

export interface LoadOutputStylesOptions {
	/** Override the user home (tests). */
	home?: string;
	/** Project root whose .codebase/output-styles/ is merged on top. */
	cwd?: string;
}

/**
 * Load every available output style, project layer over user layer.
 * Missing directories yield no styles. Malformed files are skipped
 * with a stderr note so one typo doesn't hide the rest.
 */
export function loadOutputStyles(options: LoadOutputStylesOptions = {}): OutputStyle[] {
	const home = options.home ?? homedir();
	const byId = new Map<string, OutputStyle>();
	// User layer first, then project so project wins on id collision.
	for (const dir of [
		join(home, ".codebase", "output-styles"),
		options.cwd ? join(options.cwd, ".codebase", "output-styles") : null,
	]) {
		if (!dir) continue;
		for (const style of readDir(dir)) byId.set(style.id, style);
	}
	return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** Resolve a single style by id (case-insensitive). undefined if not found. */
export function getOutputStyle(id: string, options: LoadOutputStylesOptions = {}): OutputStyle | undefined {
	const want = id.trim().toLowerCase();
	return loadOutputStyles(options).find((s) => s.id === want);
}

function readDir(dir: string): OutputStyle[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			process.stderr.write(`[output-styles] could not list ${dir}: ${(err as Error).message}\n`);
		}
		return [];
	}
	const out: OutputStyle[] = [];
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const full = join(dir, name);
		try {
			if (!statSync(full).isFile()) continue;
			const { frontmatter, body } = parseMarkdownWithFrontmatter(readFileSync(full, "utf8"));
			const id = name.replace(/\.md$/, "").toLowerCase();
			if (!body.trim()) continue; // an empty style is useless — skip it
			out.push({
				id,
				name: strOrUndef(frontmatter.name) ?? id,
				description: strOrUndef(frontmatter.description) ?? "",
				body: body.trim(),
			});
		} catch (err) {
			process.stderr.write(`[output-styles] could not parse ${full}: ${(err as Error).message}\n`);
		}
	}
	return out;
}
