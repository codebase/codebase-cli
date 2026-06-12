import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * Pre-image checkpointing for file-mutating tools. Before write_file /
 * edit_file / multi_edit / notebook_edit touch a file, the wrapper calls
 * record() with the file's current bytes (or its absence). /rewind then
 * restores any prior point by writing the oldest pre-image per path back
 * and deleting files that didn't exist yet.
 *
 * Pre-image bytes live on disk under ~/.codebase/checkpoints/<run-id>/ —
 * raw Buffers, so encoding/BOM/EOL round-trip exactly. Only the small
 * entry records stay in memory. The blob dir is removed on dispose();
 * runs that died without cleanup are swept after 7 days on next start.
 *
 * Everything here is fail-soft: a checkpoint failure must never block
 * the edit it precedes.
 */

export interface CheckpointEntry {
	/** Monotonic id, 1-based. /rewind addresses entries by this. */
	seq: number;
	/** Absolute path of the mutated file. */
	path: string;
	/** Path relative to cwd, for display. */
	display: string;
	/** Tool that performed the mutation. */
	tool: string;
	/** False when the file did not exist before the mutation. */
	existed: boolean;
	/** True when the file was too large to snapshot (rewind will skip it). */
	tooLarge: boolean;
	timestamp: number;
}

export interface RewoundFile {
	path: string;
	display: string;
}

export interface RewindResult {
	restored: RewoundFile[];
	deleted: RewoundFile[];
	/** Files we couldn't restore (snapshot skipped or blob unreadable). */
	skipped: RewoundFile[];
}

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CheckpointStoreOptions {
	cwd: string;
	/** Defaults to ~/.codebase. Tests supply a tmp dir. */
	dataRoot?: string;
}

export class CheckpointStore {
	private readonly cwd: string;
	private readonly blobDir: string;
	private readonly entries: CheckpointEntry[] = [];
	private nextSeq = 1;
	private dirReady = false;

	constructor(options: CheckpointStoreOptions) {
		this.cwd = options.cwd;
		const root = join(options.dataRoot ?? join(homedir(), ".codebase"), "checkpoints");
		sweepStale(root);
		this.blobDir = join(root, `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
	}

	/**
	 * Capture the pre-image of `absPath` before a mutation. Returns the
	 * entry's seq so the caller can discard() it if the mutation never
	 * happened (validation refusal, tool error).
	 */
	record(tool: string, absPath: string): number | undefined {
		try {
			const entry: CheckpointEntry = {
				seq: this.nextSeq,
				path: absPath,
				display: displayPath(this.cwd, absPath),
				tool,
				existed: false,
				tooLarge: false,
				timestamp: Date.now(),
			};
			try {
				const stat = statSync(absPath);
				if (!stat.isFile()) return undefined;
				if (stat.size > MAX_SNAPSHOT_BYTES) {
					entry.existed = true;
					entry.tooLarge = true;
				} else {
					const bytes = readFileSync(absPath);
					this.ensureDir();
					writeFileSync(this.blobPath(entry.seq), bytes);
					entry.existed = true;
				}
			} catch {
				// ENOENT — the mutation is creating this file. existed stays false.
			}
			this.entries.push(entry);
			this.nextSeq++;
			return entry.seq;
		} catch {
			return undefined;
		}
	}

	/** Drop an entry whose mutation never landed (refused or threw). */
	discard(seq: number | undefined): void {
		if (seq === undefined) return;
		const idx = this.entries.findIndex((e) => e.seq === seq);
		if (idx === -1) return;
		this.entries.splice(idx, 1);
		try {
			unlinkSync(this.blobPath(seq));
		} catch {
			// no blob (new file) — fine
		}
	}

	/** Chronological. */
	list(): readonly CheckpointEntry[] {
		return this.entries;
	}

	/**
	 * Restore every file to its state just before entry `seq`. For each
	 * path touched at-or-after seq, the OLDEST pre-image in that range
	 * wins (it's the closest to the target point in time). Undone entries
	 * are dropped from the list.
	 */
	rewindTo(seq: number): RewindResult {
		const result: RewindResult = { restored: [], deleted: [], skipped: [] };
		const range = this.entries.filter((e) => e.seq >= seq);
		if (range.length === 0) return result;
		const oldestPerPath = new Map<string, CheckpointEntry>();
		for (const entry of range) {
			if (!oldestPerPath.has(entry.path)) oldestPerPath.set(entry.path, entry);
		}
		for (const entry of oldestPerPath.values()) {
			const file: RewoundFile = { path: entry.path, display: entry.display };
			if (entry.tooLarge) {
				result.skipped.push(file);
				continue;
			}
			try {
				if (!entry.existed) {
					try {
						unlinkSync(entry.path);
					} catch {
						// already gone — that IS the pre-image state
					}
					result.deleted.push(file);
				} else {
					const bytes = readFileSync(this.blobPath(entry.seq));
					mkdirSync(dirname(entry.path), { recursive: true });
					writeFileSync(entry.path, bytes);
					result.restored.push(file);
				}
			} catch {
				result.skipped.push(file);
			}
		}
		// Drop the undone tail (and its blobs).
		for (const entry of range) {
			try {
				unlinkSync(this.blobPath(entry.seq));
			} catch {
				// no blob
			}
		}
		const firstUndone = this.entries.findIndex((e) => e.seq >= seq);
		if (firstUndone !== -1) this.entries.splice(firstUndone);
		return result;
	}

	/** Remove this run's blob directory. Idempotent. */
	dispose(): void {
		try {
			rmSync(this.blobDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}

	private blobPath(seq: number): string {
		return join(this.blobDir, `${seq}.blob`);
	}

	private ensureDir(): void {
		if (this.dirReady) return;
		mkdirSync(this.blobDir, { recursive: true });
		this.dirReady = true;
	}
}

function displayPath(cwd: string, absPath: string): string {
	const rel = relative(cwd, absPath);
	return rel && !rel.startsWith("..") ? rel : absPath;
}

/** Remove checkpoint dirs from runs that exited without dispose(). */
function sweepStale(root: string): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	const cutoff = Date.now() - SWEEP_AGE_MS;
	for (const name of names) {
		const dir = join(root, name);
		try {
			if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
		} catch {
			// racing another instance — fine
		}
	}
}
