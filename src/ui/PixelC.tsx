import { Box, Text } from "ink";

/**
 * Static pixel-C brand mark. Mirrors `web/public/favicon.svg`:
 * 5-row × 4-col grid, 9 filled pixels (3 top + 3 left + 3 bottom).
 * Each SVG pixel renders as two block chars wide so the C reads
 * proportionally in a 1:2 cell-ratio terminal.
 */

const FILL = "██";
const GAP = "  ";

interface PixelCProps {
	color?: string;
}

// Row id doubles as the React key. Names describe the C shape so the
// keys are stable regardless of order (biome's array-index-as-key rule
// is right in general — but here the rows aren't unique by content
// (the three FILL rows repeat), so we lean on positional ids).
const ROWS: readonly { id: string; text: string }[] = [
	{ id: "top", text: `${GAP}${FILL}${FILL}${FILL}` },
	{ id: "mid-1", text: FILL },
	{ id: "mid-2", text: FILL },
	{ id: "mid-3", text: FILL },
	{ id: "bot", text: `${GAP}${FILL}${FILL}${FILL}` },
];

export function PixelC({ color = "cyan" }: PixelCProps) {
	return (
		<Box flexDirection="column">
			{ROWS.map((row) => (
				<Text key={row.id} bold color={color}>
					{row.text}
				</Text>
			))}
		</Box>
	);
}
