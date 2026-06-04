/** How much rope a director has — maps directly onto the permission gate. */
export type Autonomy = "cautious" | "balanced" | "autonomous";

/**
 * A "director": a hired, role-scoped agent persona. Persisted as a
 * markdown file at ~/.codebase/directors/<slug>.md — frontmatter holds
 * the structured fields, the body is the human-editable handbook.
 */
export interface Director {
	/** @handle and filename stem, e.g. "marketing". */
	slug: string;
	/** Display name, e.g. "Director of Marketing". */
	name: string;
	/** One line: what this director owns. */
	mandate: string;
	/**
	 * The rope. cautious = ask before acting; balanced = act on routine
	 * work but gate the irreversible; autonomous = same, plus the
	 * pre-trusted ops in `trusts`.
	 */
	autonomy: Autonomy;
	/**
	 * Permission allow-patterns this director has been honed to trust —
	 * normally-gated ops it's pre-authorized for (e.g.
	 * "shell:git push origin marketing*"). Grows as you build confidence.
	 */
	trusts: readonly string[];
	/** The employee handbook: context, voice, do's/don'ts. Markdown. */
	handbook: string;
}
