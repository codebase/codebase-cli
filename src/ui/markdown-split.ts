/**
 * Split assistant markdown into prose and fenced-code segments so the
 * TUIs can render code blocks as discrete copy targets while leaving
 * prose to the normal markdown renderer. Used by the pi-tui transcript;
 * lives under src/ui/ so both render paths can share it.
 *
 * Recognizes ``` and ~~~ fences (with an optional language tag), only at
 * the start of a line. An unterminated fence is treated as prose — better
 * to render it normally than to swallow the rest of the message into a
 * box that never closes.
 */

export interface MarkdownSegment {
	type: "prose" | "code";
	text: string;
	/** Language tag for code segments (may be empty). */
	lang?: string;
}

const FENCE = /^([`~]{3,})[ \t]*([^\n`]*)$/;

export function splitMarkdownSegments(markdown: string): MarkdownSegment[] {
	const lines = markdown.split("\n");
	const segments: MarkdownSegment[] = [];
	let prose: string[] = [];
	let i = 0;

	const flushProse = () => {
		if (prose.length === 0) return;
		const text = prose.join("\n");
		// Keep whitespace-only prose out of the segment list — it's just the
		// gap between a paragraph and a fence.
		if (text.trim().length > 0) segments.push({ type: "prose", text: text.replace(/\n+$/, "") });
		prose = [];
	};

	while (i < lines.length) {
		const open = FENCE.exec(lines[i]);
		if (open) {
			const ticks = open[1];
			const lang = open[2].trim();
			// Find the matching closing fence (same char, length ≥ opener).
			let close = -1;
			for (let j = i + 1; j < lines.length; j++) {
				const c = /^([`~]{3,})\s*$/.exec(lines[j]);
				if (c && c[1][0] === ticks[0] && c[1].length >= ticks.length) {
					close = j;
					break;
				}
			}
			if (close === -1) {
				// Unterminated — treat the fence line as prose and move on.
				prose.push(lines[i]);
				i++;
				continue;
			}
			flushProse();
			segments.push({ type: "code", lang, text: lines.slice(i + 1, close).join("\n") });
			i = close + 1;
			continue;
		}
		prose.push(lines[i]);
		i++;
	}
	flushProse();
	return segments;
}
