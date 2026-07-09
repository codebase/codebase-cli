import type { MemoryStore } from "./store.js";
import type { MemoryRecord } from "./types.js";

const MAX_RELEVANT_MEMORIES = 3;
const MAX_MEMORY_BODY_CHARS = 1600;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_RANK_PENALTY = 6;

const FIELD_WEIGHTS = {
	filename: 5,
	name: 5,
	description: 4,
	body: 1,
	source: 1,
	type: 1,
} as const;

type MatchField = keyof typeof FIELD_WEIGHTS;

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
	"make",
	"must",
	"new",
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

const TOKEN_ALIASES = new Map([
	["deployed", "deploy"],
	["deploying", "deploy"],
	["deployment", "deploy"],
	["deployments", "deploy"],
	["deploys", "deploy"],
	["validated", "validate"],
	["validating", "validate"],
	["validation", "validate"],
	["validations", "validate"],
	["verified", "verify"],
	["verifying", "verify"],
	["verification", "verify"],
	["verifications", "verify"],
]);

const HISTORICAL_QUERY_TOKENS = new Set([
	"archive",
	"archived",
	"audit",
	"history",
	"historical",
	"legacy",
	"old",
	"stale",
]);

export interface RelevantMemoryMatch {
	record: MemoryRecord;
	score: number;
	stale: boolean;
	matchedTerms: string[];
	matchedFields: MatchField[];
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
	options: { now?: number; max?: number; recordUsage?: boolean } = {},
): string {
	const now = options.now ?? Date.now();
	const scored = findRelevantMemories(store, query, { ...options, now }).map((item) => {
		if (!options.recordUsage) return item;
		const record = store.markUsed(item.record.filename, { now }) ?? item.record;
		return { ...item, record };
	});
	if (scored.length === 0) return "";

	const lines = [
		"<system-reminder>",
		"Relevant project memories for this prompt. These are local, point-in-time notes; verify stale project facts before acting.",
		"",
	];
	for (const [idx, item] of scored.entries()) {
		lines.push(formatMemory(idx + 1, item));
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
	const wantsHistorical = [...queryTokens].some((token) => HISTORICAL_QUERY_TOKENS.has(token));
	return store
		.list()
		.map((record) => {
			const scored = scoreMemory(record, queryTokens);
			const stale = isMemoryStale(record, now);
			const score = stale && !wantsHistorical ? Math.max(1, scored.score - STALE_RANK_PENALTY) : scored.score;
			return { record, stale, score, matchedTerms: scored.matchedTerms, matchedFields: scored.matchedFields };
		})
		.filter((item) => item.matchedTerms.length > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				(wantsHistorical ? 0 : Number(a.stale) - Number(b.stale)) ||
				b.record.updatedAt - a.record.updatedAt,
		)
		.slice(0, max);
}

export function isMemoryStale(record: MemoryRecord, now = Date.now()): boolean {
	return now - record.updatedAt > STALE_AFTER_MS;
}

function formatMemory(index: number, item: RelevantMemoryMatch): string {
	const record = item.record;
	const body = truncate(record.body.trim(), MAX_MEMORY_BODY_CHARS);
	const lines = [
		`${index}. ${record.name}`,
		`   match: score ${item.score}; terms: ${formatList(item.matchedTerms)}; fields: ${formatList(item.matchedFields)}`,
		`   file: ${record.filename}; type: ${record.type}; source: ${record.source}; source_session: ${record.sourceSessionId ?? "unknown"}; created: ${formatDate(record.createdAt)}; updated: ${formatDate(record.updatedAt)}; last_used: ${formatOptionalDate(record.lastUsedAt)}; retrievals: ${record.retrievalCount}; stale: ${item.stale ? "yes" : "no"}`,
		`   description: ${record.description}`,
	];
	if (body) {
		lines.push("   body:");
		for (const line of body.split("\n")) lines.push(`   ${line}`);
	}
	lines.push("");
	return lines.join("\n");
}

function scoreMemory(
	record: MemoryRecord,
	queryTokens: Set<string>,
): { score: number; matchedTerms: string[]; matchedFields: MatchField[] } {
	const fieldTokens: Record<MatchField, Set<string>> = {
		filename: tokenize(record.filename),
		name: tokenize(record.name),
		description: tokenize(record.description),
		body: tokenize(record.body),
		source: tokenize(record.source),
		type: tokenize(record.type),
	};
	let score = 0;
	const matchedTerms = new Set<string>();
	const matchedFields = new Set<MatchField>();
	for (const token of queryTokens) {
		for (const field of Object.keys(fieldTokens) as MatchField[]) {
			if (!fieldTokens[field].has(token)) continue;
			score += FIELD_WEIGHTS[field];
			matchedTerms.add(token);
			matchedFields.add(field);
		}
	}
	return {
		score,
		matchedTerms: [...matchedTerms].sort().slice(0, 12),
		matchedFields: [...matchedFields].sort(),
	};
}

function tokenize(value: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
		const token = normalizeToken(raw.replace(/^_+|_+$/g, ""));
		if (!token || STOPWORDS.has(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

function normalizeToken(token: string): string {
	return TOKEN_ALIASES.get(token) ?? token;
}

function formatList(values: readonly string[]): string {
	return values.length > 0 ? values.join(",") : "none";
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function formatDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function formatOptionalDate(ms?: number): string {
	return ms ? formatDate(ms) : "never";
}
