import { parseDate } from "./parse.ts";

// Sort an array of records by an ISO date field, oldest first. Records
// whose date field doesn't parse are pushed to the end.
export function sortByDate<T extends { dateField: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => {
		const ta = parseDate(a.dateField);
		const tb = parseDate(b.dateField);
		if (ta === null && tb === null) return 0;
		if (ta === null) return 1;
		if (tb === null) return -1;
		return ta - tb;
	});
}
