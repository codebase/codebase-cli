import type { MemoryStore } from "./store.js";

/**
 * Build the MEMORY.md system-prompt addendum. Returns "" when the
 * project has no memories yet — callers concat unconditionally so a
 * fresh project's prompt isn't littered with empty headings.
 */
export function buildMemoryAddendum(store: MemoryStore): string {
	const truncated = store.truncatedIndex();
	if (!truncated.trim()) return "";
	return `\n\n# Project memory\n\n${truncated.trim()}\n`;
}
