import wrapAnsi from "wrap-ansi";

/**
 * Pre-wrap text to fit within `maxWidth` columns at word boundaries.
 *
 * Why we pre-wrap: Ink's `<Text>` will auto-wrap, but the wraps go
 * straight to the terminal as visual line breaks. When the user
 * select-and-copies, they get those wraps as `\n` chars in their
 * clipboard — usually mid-word at column edges, which is the exact
 * pi-tui complaint. Pre-wrapping at word boundaries means the `\n`s
 * the user gets are at sensible positions.
 *
 * - `hard: true` so very long tokens (URLs, code identifiers) break
 *   at the column edge instead of overflowing.
 * - `trim: false` preserves leading whitespace (indentation) so
 *   copied code doesn't lose its structure. Trailing whitespace per
 *   line is stripped manually below — wrap-ansi's `trim: true` would
 *   kill leading whitespace too, which is the wrong tradeoff.
 */
export function wrapText(text: string, maxWidth: number): string[] {
	if (!text) return [""];
	if (maxWidth <= 0) return text.split("\n");
	const wrapped = wrapAnsi(text, maxWidth, { hard: true, trim: false });
	return wrapped.split("\n").map(stripTrailingWhitespace);
}

function stripTrailingWhitespace(line: string): string {
	return line.replace(/[ \t]+$/, "");
}
