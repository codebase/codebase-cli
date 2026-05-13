import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-instruction files we look for at the cwd root. The first
 * present file wins to avoid duplicate injection — a project that has
 * both CLAUDE.md (for one IDE) and AGENTS.md (for another) shouldn't
 * concatenate both into the prompt.
 */
const RECOGNIZED_FILES = ["AGENTS.md", "CLAUDE.md", "CODEX.md", ".cursorrules"] as const;

/** Hard cap on the injected content. Anything beyond this is truncated
 *  with a notice. Keeps a runaway CLAUDE.md from blowing the prompt. */
const MAX_BYTES = 64 * 1024;

/**
 * Build the project-instructions system-prompt addendum. Reads the
 * first recognized file at the cwd root (AGENTS.md / CLAUDE.md /
 * CODEX.md / .cursorrules) and returns it wrapped in a labeled
 * section. Returns "" when no file is present.
 */
export function buildProjectFilesAddendum(cwd: string): string {
	for (const name of RECOGNIZED_FILES) {
		const path = join(cwd, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) continue;
			let content = readFileSync(path, "utf8");
			let truncated = false;
			if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
				// Slice by bytes, then trim back to a char boundary by
				// re-decoding. utf8 truncation can split a multibyte
				// sequence; slicing the string and re-encoding is safer
				// than buffer math here.
				content = content.slice(0, MAX_BYTES);
				while (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
					content = content.slice(0, -1);
				}
				truncated = true;
			}
			const header = `\n\n# Project instructions (${name})\n\n`;
			const footer = truncated ? `\n\n(…truncated; full file at ${path})` : "";
			return `${header}${content.trim()}${footer}\n`;
		} catch {
			// File missing or unreadable — move on to the next candidate.
		}
	}
	return "";
}
