import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
	AmbiguousMatchError,
	FileNotReadFirstError,
	FileUnexpectedlyModifiedError,
	NoMatchError,
	PartialViewEditError,
	PathOutsideCwdError,
} from "./errors.js";
import type { FileSnapshot, FileStateCache } from "./file-state-cache.js";

/**
 * Resolve a user-supplied path against cwd and reject anything that escapes.
 * Symlinks are followed at read/stat time, so this is a best-effort guard
 * against absolute paths and `..` traversal — combine with realpath checks
 * before sensitive operations if you don't trust the working tree.
 *
 * Opt-out: `CODEBASE_NO_PROJECT_ROOT=1` (set explicitly or via the
 * `--unrestricted` CLI flag) skips the clamp entirely. The agent can
 * then reach anywhere the running user can — useful for system-admin
 * sessions, debugging across multiple projects, comparing against
 * ~/.config, etc. Default stays clamped to keep new-user blast radius
 * small.
 */
export function resolveInsideCwd(cwd: string, requested: string): string {
	const absCwd = resolve(cwd);
	const candidate = isAbsolute(requested) ? resolve(requested) : resolve(absCwd, requested);
	if (process.env.CODEBASE_NO_PROJECT_ROOT === "1") return candidate;
	if (candidate !== absCwd && !candidate.startsWith(absCwd + sep)) {
		throw new PathOutsideCwdError(requested);
	}
	return candidate;
}

/** Detect newline style. Empty string for files with no newline. */
export function detectEol(content: string): "\n" | "\r\n" | "" {
	const idx = content.indexOf("\n");
	if (idx === -1) return "";
	return idx > 0 && content[idx - 1] === "\r" ? "\r\n" : "\n";
}

/** Text encodings we detect via BOM and round-trip on write. */
export type FileEncoding = "utf8" | "utf16le" | "utf16be";

/**
 * Decode a file buffer, detecting + stripping a leading BOM. Handles
 * UTF-8 (EF BB BF), UTF-16LE (FF FE), and UTF-16BE (FE FF). UTF-16BE
 * has no native Node decoder, so we byte-swap to LE first. The detected
 * encoding is returned so the write path can re-encode identically — a
 * Windows-authored UTF-16 file stays UTF-16 after an edit.
 */
export function stripBOM(buf: Buffer): { content: string; hasBOM: boolean; encoding: FileEncoding } {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return { content: buf.subarray(3).toString("utf8"), hasBOM: true, encoding: "utf8" };
	}
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		return { content: buf.subarray(2).toString("utf16le"), hasBOM: true, encoding: "utf16le" };
	}
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		// UTF-16BE: swap byte pairs to LE so Node can decode.
		const body = buf.subarray(2);
		const swapped = Buffer.from(body);
		swapped.swap16();
		return { content: swapped.toString("utf16le"), hasBOM: true, encoding: "utf16be" };
	}
	return { content: buf.toString("utf8"), hasBOM: false, encoding: "utf8" };
}

/**
 * Heuristic null-byte scan over the first 8 KB. A UTF-16 BOM is checked
 * first — UTF-16 text is full of legitimate null bytes (every ASCII
 * char is `XX 00`), so the raw scan would false-positive every
 * Windows-authored UTF-16 file as "binary."
 */
export function isLikelyBinary(buf: Buffer): boolean {
	if (buf.length >= 2) {
		const b0 = buf[0];
		const b1 = buf[1];
		if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return false;
	}
	const slice = buf.subarray(0, Math.min(buf.length, 8192));
	for (let i = 0; i < slice.length; i++) {
		if (slice[i] === 0) return true;
	}
	return false;
}

/**
 * Validate a file is safe to overwrite. Throws typed errors so the LLM gets
 * actionable feedback when its context has drifted from disk:
 *   - missing snapshot → FileNotReadFirstError ("read it first")
 *   - mtime/size drift → FileUnexpectedlyModifiedError ("read it again")
 *   - partial-view read → PartialViewEditError ("read the full file")
 *
 * Opt-out: `CODEBASE_NO_READ_BEFORE_WRITE=1` (or `--unrestricted`)
 * returns a synthetic snapshot so write_file / edit_file / multi_edit
 * proceed even if the model never read the file in this turn. Useful
 * for "generate this file from scratch" workflows where the read-first
 * check is friction. Drift detection still fires when the snapshot
 * is present and stale.
 */
export function validateForOverwrite(absPath: string, cache: FileStateCache): FileSnapshot {
	const status = cache.check(absPath);
	if (status === "missing") {
		if (process.env.CODEBASE_NO_READ_BEFORE_WRITE === "1") {
			// Synthesize a "we never looked" snapshot so the caller proceeds.
			// Drift detection only matters when we DO have a prior snapshot;
			// without one, the user has explicitly told us to skip the check.
			return {
				path: absPath,
				content: "",
				mtimeMs: 0,
				size: 0,
				hasBOM: false,
				eol: "\n",
				isPartialView: false,
				storedAt: Date.now(),
			};
		}
		throw new FileNotReadFirstError(absPath);
	}
	if (status === "modified") throw new FileUnexpectedlyModifiedError(absPath);

	const snap = cache.get(absPath);
	if (!snap) {
		if (process.env.CODEBASE_NO_READ_BEFORE_WRITE === "1") {
			return {
				path: absPath,
				content: "",
				mtimeMs: 0,
				size: 0,
				hasBOM: false,
				eol: "\n",
				isPartialView: false,
				storedAt: Date.now(),
			};
		}
		throw new FileNotReadFirstError(absPath);
	}
	if (snap.isPartialView) throw new PartialViewEditError(absPath);
	return snap;
}

export interface ApplyEditOptions {
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	path: string;
}

/**
 * Apply a single string replacement. Single-match by default; replace_all
 * substitutes every occurrence. Throws NoMatchError / AmbiguousMatchError
 * with file-path context so the model can self-correct.
 */
export function applyEdit(content: string, opts: ApplyEditOptions): { content: string; replacements: number } {
	const { oldString, newString, replaceAll, path } = opts;
	if (oldString.length === 0) {
		throw new Error("old_string must be non-empty. Use write_file to create a new file.");
	}
	if (oldString === newString) {
		throw new Error("old_string and new_string are identical; nothing to change.");
	}

	if (replaceAll) {
		const parts = content.split(oldString);
		if (parts.length === 1) throw new NoMatchError(path);
		return { content: parts.join(newString), replacements: parts.length - 1 };
	}

	const first = content.indexOf(oldString);
	if (first === -1) throw new NoMatchError(path);
	const second = content.indexOf(oldString, first + oldString.length);
	if (second !== -1) {
		let count = 2;
		let cursor = second + oldString.length;
		while (true) {
			const next = content.indexOf(oldString, cursor);
			if (next === -1) break;
			count++;
			cursor = next + oldString.length;
		}
		throw new AmbiguousMatchError(path, count);
	}
	return {
		content: content.slice(0, first) + newString + content.slice(first + oldString.length),
		replacements: 1,
	};
}

export interface WriteOptions {
	hasBOM?: boolean;
	eol?: "\n" | "\r\n" | "";
	mode?: number;
	/** Re-encode with this encoding + matching BOM. Default "utf8". */
	encoding?: FileEncoding;
}

/**
 * Write content to disk via tmp+rename. Restores BOM and line endings from
 * the originating snapshot so a Windows-authored file stays Windows-formatted
 * after edits. The tmp file is removed on failure.
 */
export function atomicWrite(
	absPath: string,
	content: string,
	options: WriteOptions = {},
): { mtimeMs: number; size: number } {
	const eol = options.eol ?? detectEol(content);
	const normalized =
		eol === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : eol === "\n" ? content.replace(/\r\n/g, "\n") : content;

	const encoding = options.encoding ?? "utf8";
	let buf: Buffer;
	if (encoding === "utf16le") {
		const body = Buffer.from(normalized, "utf16le");
		buf = options.hasBOM ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
	} else if (encoding === "utf16be") {
		const le = Buffer.from(normalized, "utf16le");
		le.swap16(); // LE → BE
		buf = options.hasBOM ? Buffer.concat([Buffer.from([0xfe, 0xff]), le]) : le;
	} else {
		const body = Buffer.from(normalized, "utf8");
		buf = options.hasBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
	}

	mkdirSync(dirname(absPath), { recursive: true });
	const tmp = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, buf, { mode: options.mode ?? 0o644 });
		renameSync(tmp, absPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}

	const stat = statSync(absPath);
	return { mtimeMs: stat.mtimeMs, size: stat.size };
}

/** True if the path exists on disk (without throwing). */
export function pathExists(absPath: string): boolean {
	return existsSync(absPath);
}
