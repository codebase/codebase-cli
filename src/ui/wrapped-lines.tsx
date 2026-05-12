import { Text } from "ink";
import { wrapText } from "./wrap.js";

export interface WrappedLinesProps {
	text: string;
	width: number;
	keyPrefix: string;
	color?: string;
	dimColor?: boolean;
	italic?: boolean;
}

/**
 * Render text as N <Text> elements, one per pre-wrapped line. Stacks
 * vertically inside the parent column-flex Box. Pre-wrap means the
 * wraps happen at word boundaries, so when the user select-and-copies
 * they get clean line endings — no mid-word breaks at column edges.
 */
export function WrappedLines({ text, width, keyPrefix, color, dimColor, italic }: WrappedLinesProps) {
	const lines = wrapText(text, width);
	return (
		<>
			{lines.map((line, i) => (
				// Wrapped lines have no per-line state — <Text> is pure-presentational —
				// so reusing instances on re-wrap is harmless; index-as-key is fine here.
				// biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf, reuse is safe
				<Text key={`${keyPrefix}:${i}`} color={color} dimColor={dimColor} italic={italic}>
					{line.length === 0 ? " " : line}
				</Text>
			))}
		</>
	);
}
