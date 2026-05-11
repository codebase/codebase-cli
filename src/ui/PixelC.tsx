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

const ROWS: readonly string[] = [
	`${GAP}${FILL}${FILL}${FILL}`,
	FILL,
	FILL,
	FILL,
	`${GAP}${FILL}${FILL}${FILL}`,
];

export function PixelC({ color = "cyan" }: PixelCProps) {
	return (
		<Box flexDirection="column">
			{ROWS.map((text, i) => (
				<Text key={`pixc-${i}`} bold color={color}>
					{text}
				</Text>
			))}
		</Box>
	);
}
