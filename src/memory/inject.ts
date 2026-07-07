import type { MemoryStore } from "./store.js";
import type { MemoryRecord } from "./types.js";

const MAX_RELEVANT_MEMORIES = 3;
const MAX_MEMORY_BODY_CHARS = 1600;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"and",
	"are",
	"because",
	"but",
	"can",
	"for",
	"from",
	"how",
	"into",
	"not",
	"now",
	"our",
	"please",
	"should",
	"that",
	"the",
	"this",
	"with",
	"you",
]);

export interface RelevantMemoryMatch {
	record: MemoryRecord;
	score: number;
	stale: boolean;
}

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

/**
 * Prompt-time memory recall. The system prompt carries the MEMORY.md index,
 * but full memory bodies are injected only when the current prompt appears
 * related. This keeps context small while making saved memories actually
 * useful for follow-up work.
 */
export function buildRelevantMemoryReminder(
	store: MemoryStore,
	query: string,
	options: { now?: number; max?: number } = {},
): string {
	const now = options.now ?? Date.now();
	const scored = findRelevantMemories(store, query, { ...options, now });
	if (scored.length === 0) return "";

	const lines = [
		"<system-reminder>",
		"Relevant project memories for this prompt. These are local, point-in-time notes; verify stale project facts before acting.",
		"",
	];
	for (const [idx, item] of scored.entries()) {
		lines.push(formatMemory(idx + 1, item.record, now));
	}
	lines.push("</system-reminder>");
	return lines.join("\n");
}

export function findRelevantMemories(
	store: MemoryStore,
	query: string,
	options: { now?: number; max?: number } = {},
): RelevantMemoryMatch[] {
	const queryTokens = tokenize(query);
	if (queryTokens.size === 0) return [];
	const now = options.now ?? Date.now();
	const max = options.max ?? MAX_RELEVANT_MEMORIES;
	return store
		.list()
		.map((record) => ({ record, score: scoreMemory(record, queryTokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
		.slice(0, max)
		.map((item) => ({ ...item, stale: isMemoryStale(item.record, now) }));
}

export function isMemoryStale(record: MemoryRecord, now = Date.now()): boolean {
	return now - record.updatedAt > STALE_AFTER_MS;
}

function formatMemory(index: number, record: MemoryRecord, now: number): string {
	const stale = isMemoryStale(record, now);
	const body = truncate(record.body.trim(), MAX_MEMORY_BODY_CHARS);
	const lines = [
		`${index}. ${record.name}`,
		`   file: ${record.filename}; type: ${record.type}; source: ${record.source}; created: ${formatDate(record.createdAt)}; updated: ${formatDate(record.updatedAt)}; stale: ${stale ? "yes" : "no"}`,
		`   description: ${record.description}`,
	];
	if (body) {
		lines.push("   body:");
		for (const line of body.split("\n")) lines.push(`   ${line}`);
	}
	lines.push("");
	return lines.join("\n");
}

function scoreMemory(record: MemoryRecord, queryTokens: Set<string>): number {
	const headerTokens = tokenize(`${record.name} ${record.description} ${record.type} ${record.filename}`);
	const bodyTokens = tokenize(record.body);
	let score = 0;
	for (const token of queryTokens) {
		if (headerTokens.has(token)) score += 4;
		if (bodyTokens.has(token)) score += 1;
	}
	return score;
}

function tokenize(value: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
		const token = raw.replace(/^_+|_+$/g, "");
		if (!token || STOPWORDS.has(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function formatDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}
