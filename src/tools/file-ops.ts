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
 */
export function resolveInsideCwd(cwd: string, requested: string): string {
	const absCwd = resolve(cwd);
	const candidate = isAbsolute(requested) ? resolve(requested) : resolve(absCwd, requested);
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

/** Strip a UTF-8 BOM if present and return the decoded string. */
export function stripBOM(buf: Buffer): { content: string; hasBOM: boolean } {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return { content: buf.subarray(3).toString("utf8"), hasBOM: true };
	}
	return { content: buf.toString("utf8"), hasBOM: false };
}

/** Heuristic null-byte scan over the first 8 KB. */
export function isLikelyBinary(buf: Buffer): boolean {
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
 */
export function validateForOverwrite(absPath: string, cache: FileStateCache): FileSnapshot {
	const status = cache.check(absPath);
	if (status === "missing") throw new FileNotReadFirstError(absPath);
	if (status === "modified") throw new FileUnexpectedlyModifiedError(absPath);

	const snap = cache.get(absPath);
	if (!snap) throw new FileNotReadFirstError(absPath);
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

	let buf = Buffer.from(normalized, "utf8");
	if (options.hasBOM) {
		buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
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
