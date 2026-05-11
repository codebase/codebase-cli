import { Box, Text } from "ink";
import { wrapText } from "./wrap.js";

/**
 * Minimal markdown renderer for assistant messages. Handles the four
 * shapes that show up in 95% of real responses:
 *   **bold**         → bold span
 *   *italic*         → italic span
 *   `inline code`    → cyan span
 *   ```code fence``` → indented cyan block (no syntax highlighting yet)
 *   # heading        → bold span (one of three levels)
 *
 * Anything we don't recognize falls through as plain text. The
 * renderer pre-wraps each line so terminal select-copy still gives
 * clean line endings, same invariant as `WrappedLines`.
 *
 * Not handled (yet): bullet lists, ordered lists, blockquotes, links,
 * tables. They get rendered as plain text. We'll add them when they
 * actually show up in our scenarios.
 */

interface MarkdownProps {
	text: string;
	width: number;
	keyPrefix: string;
}

type Span = { kind: "text" | "bold" | "italic" | "code"; text: string };
type Block =
	| { kind: "paragraph"; spans: Span[] }
	| { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
	| { kind: "code-block"; lang?: string; text: string }
	| { kind: "blank" };

export function Markdown({ text, width, keyPrefix }: MarkdownProps) {
	const blocks = parseBlocks(text);
	return (
		<Box flexDirection="column">
			{blocks.map((block, i) => (
				<MarkdownBlock
					key={`${keyPrefix}-${i}-${block.kind}`}
					block={block}
					width={width}
					keyPrefix={`${keyPrefix}-${i}`}
				/>
			))}
		</Box>
	);
}

function MarkdownBlock({ block, width, keyPrefix }: { block: Block; width: number; keyPrefix: string }) {
	if (block.kind === "blank") {
		return <Text> </Text>;
	}
	if (block.kind === "code-block") {
		const lines = block.text.split("\n");
		return (
			<Box flexDirection="column" marginLeft={2}>
				{lines.map((line, i) => (
					<Text key={`${keyPrefix}-cl-${i}-${line.slice(0, 12)}`} color="cyan">
						{line.length === 0 ? " " : line}
					</Text>
				))}
			</Box>
		);
	}
	if (block.kind === "heading") {
		return <SpanLine spans={block.spans} width={width} bold color="cyan" keyPrefix={keyPrefix} />;
	}
	return <SpanLine spans={block.spans} width={width} keyPrefix={keyPrefix} />;
}

/**
 * Render a sequence of inline spans, wrapped to `width`. We wrap on
 * the plain-text representation, then walk the spans in parallel to
 * decide where to break and what styling each chunk gets. This keeps
 * select-copy clean while preserving styled segments across line
 * breaks.
 */
function SpanLine({
	spans,
	width,
	bold,
	color,
	keyPrefix,
}: {
	spans: Span[];
	width: number;
	bold?: boolean;
	color?: string;
	keyPrefix: string;
}) {
	// For the first cut: serialize spans into one rich-text line, wrap
	// the plain projection, and emit one <Text> per row with all spans
	// inlined. Wrap calculation uses the plain text so column counts
	// stay accurate; the rendered output retains the styling.
	const plain = spans.map((s) => s.text).join("");
	const wrapped = wrapText(plain, width);
	let consumed = 0;
	return (
		<>
			{wrapped.map((line, lineIdx) => {
				const chunks = sliceSpans(spans, consumed, consumed + line.length);
				consumed += line.length;
				// Account for the line break (wrap-ansi drops the trailing space).
				if (lineIdx < wrapped.length - 1 && plain[consumed] === " ") consumed += 1;
				const rowKey = `${keyPrefix}-r-${lineIdx}-${line.slice(0, 12)}`;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: pure presentational, no per-row state
					<Text key={rowKey}>
						{chunks.map((c, ci) => (
							<Text
								// biome-ignore lint/suspicious/noArrayIndexKey: pure presentational
								key={`${rowKey}-c${ci}`}
								bold={bold || c.kind === "bold"}
								italic={c.kind === "italic"}
								color={c.kind === "code" ? "cyan" : color}
							>
								{c.text}
							</Text>
						))}
					</Text>
				);
			})}
		</>
	);
}

/** Slice the span sequence to the [start, end) range of the plain projection. */
function sliceSpans(spans: Span[], start: number, end: number): Span[] {
	const out: Span[] = [];
	let cursor = 0;
	for (const span of spans) {
		const spanEnd = cursor + span.text.length;
		if (spanEnd <= start) {
			cursor = spanEnd;
			continue;
		}
		if (cursor >= end) break;
		const sliceStart = Math.max(0, start - cursor);
		const sliceEnd = Math.min(span.text.length, end - cursor);
		out.push({ kind: span.kind, text: span.text.slice(sliceStart, sliceEnd) });
		cursor = spanEnd;
	}
	return out;
}

// ── parsing ─────────────────────────────────────────────────────────

function parseBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// Fenced code block.
		const fence = line.match(/^```(.*)$/);
		if (fence) {
			const lang = fence[1].trim() || undefined;
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].match(/^```\s*$/)) {
				body.push(lines[i]);
				i++;
			}
			i++; // skip closing fence (or EOF)
			blocks.push({ kind: "code-block", lang, text: body.join("\n") });
			continue;
		}
		// Blank line.
		if (line.trim() === "") {
			blocks.push({ kind: "blank" });
			i++;
			continue;
		}
		// Heading.
		const heading = line.match(/^(#{1,3})\s+(.+)$/);
		if (heading) {
			const level = heading[1].length as 1 | 2 | 3;
			blocks.push({ kind: "heading", level, spans: parseInline(heading[2]) });
			i++;
			continue;
		}
		// Paragraph (consume until blank line, fence, or heading).
		const paraLines: string[] = [line];
		i++;
		while (i < lines.length) {
			const peek = lines[i];
			if (peek.trim() === "") break;
			if (peek.match(/^```/)) break;
			if (peek.match(/^#{1,3}\s+/)) break;
			paraLines.push(peek);
			i++;
		}
		blocks.push({ kind: "paragraph", spans: parseInline(paraLines.join(" ")) });
	}
	return blocks;
}

/**
 * Split a single line of inline text into styled spans. Greedy, non-
 * nested — `**bold _italic_**` doesn't render correctly, but plain
 * `**bold**` and `*italic*` and `` `code` `` all work, which is what
 * 95% of real responses look like.
 */
function parseInline(text: string): Span[] {
	const spans: Span[] = [];
	const pattern = /(\*\*(.+?)\*\*|`([^`]+?)`|\*([^*\s][^*]*?)\*)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(pattern)) {
		const matchStart = match.index ?? 0;
		if (matchStart > lastIndex) {
			spans.push({ kind: "text", text: text.slice(lastIndex, matchStart) });
		}
		if (match[2] !== undefined) spans.push({ kind: "bold", text: match[2] });
		else if (match[3] !== undefined) spans.push({ kind: "code", text: match[3] });
		else if (match[4] !== undefined) spans.push({ kind: "italic", text: match[4] });
		lastIndex = matchStart + match[0].length;
	}
	if (lastIndex < text.length) {
		spans.push({ kind: "text", text: text.slice(lastIndex) });
	}
	if (spans.length === 0) spans.push({ kind: "text", text });
	return spans;
}
