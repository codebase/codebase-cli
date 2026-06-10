/**
 * Minimal markdown-with-frontmatter parser, shared by skills and
 * output styles. Splits a `.md` file into its YAML-ish header and body.
 *
 * The accepted YAML subset is deliberately boring so users can
 * hand-write headers without a real YAML engine: each non-blank line is
 * `key: value`, `[a, b, c]` becomes a string list, quoted strings honor
 * `"…"`/`'…'`. No nested objects, multi-line values, or anchors.
 */

export interface ParsedMarkdown {
	frontmatter: Record<string, string | readonly string[]>;
	body: string;
}

/**
 * Split a markdown file into frontmatter + body. Tolerates files with
 * no frontmatter (whole file becomes the body) and preserves the body's
 * leading whitespace so prompt authors who want blank lines get them.
 */
export function parseMarkdownWithFrontmatter(raw: string): ParsedMarkdown {
	const FENCE = "---";
	const normalized = raw.replace(/^﻿/, ""); // strip BOM
	if (!normalized.startsWith(FENCE)) {
		return { frontmatter: {}, body: normalized };
	}
	const closeIdx = normalized.indexOf(`\n${FENCE}`, FENCE.length);
	if (closeIdx === -1) {
		return { frontmatter: {}, body: normalized };
	}
	const fmText = normalized.slice(FENCE.length, closeIdx).trim();
	const bodyStart = closeIdx + 1 + FENCE.length;
	const body = normalized.slice(bodyStart).replace(/^\r?\n/, "");
	return { frontmatter: parseFrontmatter(fmText), body };
}

export function parseFrontmatter(text: string): Record<string, string | readonly string[]> {
	const out: Record<string, string | readonly string[]> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!key) continue;
		if (value.startsWith("[") && value.endsWith("]")) {
			out[key] = value
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter((s) => s.length > 0);
		} else {
			out[key] = unquote(value);
		}
	}
	return out;
}

export function unquote(s: string): string {
	if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
		const q = s[0];
		if (s.endsWith(q)) return s.slice(1, -1);
	}
	return s;
}

/** Coerce a frontmatter value to a string, or undefined if it's a list. */
export function strOrUndef(value: string | readonly string[] | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Coerce a frontmatter value to a string list, or undefined if it's a scalar. */
export function strArrOrUndef(value: string | readonly string[] | undefined): readonly string[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
