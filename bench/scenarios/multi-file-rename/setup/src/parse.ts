// Defensive ISO-8601 date parser. Returns epoch ms or null.
export function parseDate(input: string | null | undefined): number | null {
	if (!input) return null;
	const ms = Date.parse(input);
	return Number.isFinite(ms) ? ms : null;
}
