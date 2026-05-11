import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

const MAX_RESULTS = 12;
const IGNORED_DIRS: ReadonlySet<string> = new Set([
	".git",
	"node_modules",
	".next",
	"dist",
	"build",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"target",
]);

/**
 * Complete a path prefix against the filesystem, returning up to
 * MAX_RESULTS candidates ordered alphabetically. Directories sort
 * first and end in `/` so users can tell them apart at a glance.
 *
 * `prefix` is the text after `@` — a relative or absolute path, or
 * empty. Examples:
 *   ""           → contents of cwd
 *   "src"        → siblings of cwd starting with "src"
 *   "src/ui"     → contents of src/ filtered to those starting with "ui"
 *   "src/ui/"    → contents of src/ui
 *
 * Returns the matched relative paths (still beginning with the
 * directory parts the user already typed). Caller is responsible
 * for stitching them back into the buffer.
 */
export function completePath(prefix: string, cwd: string): string[] {
	const { dir, partial } = splitPrefix(prefix);
	const root = isAbsolute(dir) ? dir : dir ? join(cwd, dir) : cwd;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const out: { name: string; isDir: boolean }[] = [];
	for (const name of entries) {
		if (name.startsWith(".") && !partial.startsWith(".")) continue;
		if (IGNORED_DIRS.has(name)) continue;
		if (!name.toLowerCase().startsWith(partial.toLowerCase())) continue;
		let isDir = false;
		try {
			isDir = statSync(join(root, name)).isDirectory();
		} catch {
			continue;
		}
		out.push({ name, isDir });
	}
	out.sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return out.slice(0, MAX_RESULTS).map(({ name, isDir }) => {
		const joined = dir ? posix.join(dir, name) : name;
		return isDir ? `${joined}/` : joined;
	});
}

/** Split "src/ui/In" into { dir: "src/ui", partial: "In" }. */
function splitPrefix(prefix: string): { dir: string; partial: string } {
	const idx = prefix.lastIndexOf("/");
	if (idx < 0) return { dir: "", partial: prefix };
	return { dir: prefix.slice(0, idx), partial: prefix.slice(idx + 1) };
}

/**
 * Locate the `@<path>` token at or immediately before the cursor.
 * Returns the start index and the typed prefix (no leading `@`), or
 * null if the cursor isn't inside an @-token.
 */
export function findAtTokenAt(buffer: string, cursor: number): { start: number; prefix: string } | null {
	if (cursor === 0) return null;
	// Walk back from cursor — accept the path-charset, stop at whitespace.
	let i = cursor;
	while (i > 0) {
		const ch = buffer[i - 1];
		if (ch === "@") {
			// Make sure it's a standalone @ (start of buffer or preceded by whitespace).
			if (i - 1 === 0 || /\s/.test(buffer[i - 2])) {
				return { start: i - 1, prefix: buffer.slice(i, cursor) };
			}
			return null;
		}
		if (!/[A-Za-z0-9_./-]/.test(ch)) return null;
		i--;
	}
	return null;
}
