/**
 * Shared logic for Ctrl-R reverse history search (ink + pi-tui render it
 * differently; the candidate/filter semantics must match).
 */

/** Newest-first, deduplicated, blanks dropped. Input is chronological. */
export function searchCandidates(history: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry.trim() || seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

/** Case-insensitive substring filter; empty query returns everything. */
export function filterHistory(candidates: readonly string[], query: string): string[] {
	const q = query.toLowerCase();
	return q ? candidates.filter((c) => c.toLowerCase().includes(q)) : [...candidates];
}

/** One display line per entry: newlines flattened, clipped to 100 chars. */
export function displayLine(entry: string): string {
	const flat = entry.replace(/\n/g, " ⏎ ");
	return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
