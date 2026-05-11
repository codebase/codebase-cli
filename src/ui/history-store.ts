import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_HISTORY = 200;

export interface HistoryStoreOptions {
	cwd: string;
	dataRoot?: string;
	max?: number;
}

/**
 * Per-cwd prompt history persisted to ~/.codebase/projects/<hash>/history.json.
 * Keeps the most recent MAX_HISTORY entries, oldest first; identical to
 * SessionStore's hashing so we share the project directory layout.
 *
 * Stored as a JSON array of strings. No metadata, no timestamps — the
 * Input component just needs the chronological list for ↑/↓ recall.
 */
export class HistoryStore {
	private readonly path: string;
	private readonly max: number;

	constructor(options: HistoryStoreOptions) {
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		const hash = createHash("sha256").update(options.cwd).digest("hex").slice(0, 8);
		this.path = join(dataRoot, "projects", hash, "history.json");
		this.max = options.max ?? MAX_HISTORY;
	}

	get filePath(): string {
		return this.path;
	}

	load(): string[] {
		if (!existsSync(this.path)) return [];
		try {
			const raw = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((s): s is string => typeof s === "string");
		} catch {
			return [];
		}
	}

	/** Append `entry`. Collapses adjacent dupes so ↑↑↑ doesn't dwell. */
	append(entry: string): void {
		const trimmed = entry.trim();
		if (!trimmed) return;
		const current = this.load();
		if (current[current.length - 1] === trimmed) return;
		const next = [...current, trimmed];
		const sliced = next.length > this.max ? next.slice(next.length - this.max) : next;
		const dir = join(this.path, "..");
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(this.path, JSON.stringify(sliced), { mode: 0o600 });
		} catch {
			// best-effort — losing one history write isn't worth surfacing an error.
		}
	}
}
