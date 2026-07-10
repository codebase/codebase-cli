/** Where a director sits on the autonomy ladder. Maps onto the permission gate. */
export type Autonomy = "cautious" | "balanced" | "autonomous";

export const AUTONOMY_LEVELS: readonly Autonomy[] = ["cautious", "balanced", "autonomous"];

/**
 * A "director": a hired, role-scoped agent persona you can hand work to and
 * walk away from. Persisted as markdown at `~/.codebase/directors/<slug>.md`
 * — frontmatter holds the structured fields, the body is the editable
 * handbook. The persona is global (reusable across projects); the trust it
 * earns is tracked per-project in its activity log.
 */
export interface Director {
	/** @handle and filename stem, e.g. "marketing". */
	slug: string;
	/** Display name, e.g. "Director of Marketing". */
	name: string;
	/** One line: what this director owns. */
	mandate: string;
	/**
	 * The rope. `cautious` = you approve every action while you shadow it;
	 * `balanced` = acts on reversible work itself, escalates the irreversible;
	 * `autonomous` = same, plus its earned `trusts`. EARNED by graduating,
	 * never chosen at hire.
	 */
	autonomy: Autonomy;
	/**
	 * Permission allow-patterns this director has earned — normally-escalated
	 * ops it's pre-authorized for (e.g. "shell:git push origin marketing*").
	 * Grows from evidence as you graduate it.
	 */
	trusts: readonly string[];
	/** The employee handbook: context, voice, do's/don'ts. Markdown. */
	handbook: string;
}
