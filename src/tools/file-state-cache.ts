import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Snapshot of a file at the moment we last read it. Edit tools validate
 * against this before writing — if the on-disk mtime drifted, the LLM has
 * stale context and we error out instead of silently overwriting.
 *
 * Mirrors Claude Code's `src/utils/fileStateCache.ts` plus extensions for
 * encoding (BOM, line endings) so the matching round-trip survives Windows
 * authored files and CRLF projects.
 */
export interface FileSnapshot {
	/** Absolute, normalized path. */
	path: string;
	/** Decoded text content, BOM stripped. */
	content: string;
	/** Stat mtime in ms when we read it. */
	mtimeMs: number;
	/** File size in bytes when we read it. */
	size: number;
	/** Whether the original bytes started with a UTF-8 BOM. */
	hasBOM: boolean;
	/** Detected newline: "\n" (LF), "\r\n" (CRLF), or "" (none). */
	eol: "\n" | "\r\n" | "";
	/** True if read used offset/limit; partial views can't be edited safely. */
	isPartialView: boolean;
	/** Range covered for partial views (1-based inclusive). */
	range?: { startLine: number; endLine: number };
	/** Wall-clock when we recorded this snapshot. */
	storedAt: number;
}

export interface FileStateCacheConfig {
	/** Max distinct files cached. Default 100. */
	maxEntries?: number;
	/** Max bytes of cached content before LRU eviction. Default 25 MB. */
	byteBudget?: number;
}

export type FreshnessCheck = "fresh" | "modified" | "missing";

/**
 * LRU cache of read file states. Map iteration order in JS is insertion
 * order, which we abuse for LRU: every `get`/`record` re-inserts to push
 * the entry to the tail; eviction takes from the head.
 */
export class FileStateCache {
	private readonly snapshots = new Map<string, FileSnapshot>();
	private bytesStored = 0;
	private readonly maxEntries: number;
	private readonly byteBudget: number;

	constructor(config: FileStateCacheConfig = {}) {
		this.maxEntries = config.maxEntries ?? 100;
		this.byteBudget = config.byteBudget ?? 25_000_000;
	}

	record(snapshot: FileSnapshot): void {
		const key = resolve(snapshot.path);
		const existing = this.snapshots.get(key);
		if (existing) {
			this.bytesStored -= byteSize(existing.content);
			this.snapshots.delete(key);
		}
		const stored: FileSnapshot = { ...snapshot, path: key };
		this.snapshots.set(key, stored);
		this.bytesStored += byteSize(snapshot.content);
		this.evictIfNeeded();
	}

	get(path: string): FileSnapshot | undefined {
		const key = resolve(path);
		const snapshot = this.snapshots.get(key);
		if (snapshot) {
			this.snapshots.delete(key);
			this.snapshots.set(key, snapshot);
		}
		return snapshot;
	}

	invalidate(path: string): void {
		const key = resolve(path);
		const existing = this.snapshots.get(key);
		if (existing) {
			this.bytesStored -= byteSize(existing.content);
			this.snapshots.delete(key);
		}
	}

	/**
	 * Compare cached state to disk:
	 *   - "fresh": cache hit and mtime matches; edit can proceed
	 *   - "modified": cache hit but mtime drifted (or file gone); caller must re-read
	 *   - "missing": no cached snapshot; caller must read first
	 */
	check(path: string): FreshnessCheck {
		const snapshot = this.get(path);
		if (!snapshot) return "missing";
		try {
			const stat = statSync(snapshot.path);
			if (stat.mtimeMs !== snapshot.mtimeMs || stat.size !== snapshot.size) {
				return "modified";
			}
			return "fresh";
		} catch {
			return "modified";
		}
	}

	size(): number {
		return this.snapshots.size;
	}

	bytes(): number {
		return this.bytesStored;
	}

	clear(): void {
		this.snapshots.clear();
		this.bytesStored = 0;
	}

	private evictIfNeeded(): void {
		while ((this.snapshots.size > this.maxEntries || this.bytesStored > this.byteBudget) && this.snapshots.size > 0) {
			const oldestKey = this.snapshots.keys().next().value as string | undefined;
			if (!oldestKey) return;
			const snap = this.snapshots.get(oldestKey);
			if (snap) this.bytesStored -= byteSize(snap.content);
			this.snapshots.delete(oldestKey);
		}
	}
}

function byteSize(s: string): number {
	return Buffer.byteLength(s, "utf8");
}
