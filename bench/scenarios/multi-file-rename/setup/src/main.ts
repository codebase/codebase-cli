import { parseDate } from "./parse.ts";

export function isFresh(input: string, ttlMs: number, now: number): boolean {
	const ts = parseDate(input);
	if (ts === null) return false;
	return now - ts < ttlMs;
}
