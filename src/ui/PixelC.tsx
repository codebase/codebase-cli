import { Box, Text } from "ink";
import { useEffect, useState } from "react";

/**
 * Animated pixel-C brand mark. Mirrors `web/public/favicon.svg`:
 * 5-row × 4-col grid, 9 filled pixels (3 top + 3 left + 3 bottom).
 * Each SVG pixel renders as two block chars wide so the C reads
 * proportionally in a 1:2 cell-ratio terminal.
 *
 * When `animate` is false, renders a static cyan C — used in the
 * wizard header and OAuth-running screen as a brand mark.
 *
 * When `animate` is true, scans a "bright" row top → bottom through
 * the C every cycle. Subtle but unmistakably alive — gives the agent
 * a heartbeat during long thinking turns without burning attention.
 */

const FILL = "██";
const GAP = "  ";

interface PixelCProps {
	animate?: boolean;
	color?: string;
	dimColor?: string;
	intervalMs?: number;
}

interface RowSpec {
	/** The textual content of the row. */
	text: string;
	/** Which animation step (0..4) this row corresponds to. */
	step: number;
}

const ROWS: readonly RowSpec[] = [
	{ text: `${GAP}${FILL}${FILL}${FILL}`, step: 0 },
	{ text: FILL, step: 1 },
	{ text: FILL, step: 2 },
	{ text: FILL, step: 3 },
	{ text: `${GAP}${FILL}${FILL}${FILL}`, step: 4 },
];
const STEPS = ROWS.length;

export function PixelC({ animate = false, color = "cyan", dimColor = "gray", intervalMs = 180 }: PixelCProps) {
	const [activeStep, setActiveStep] = useState(0);

	useEffect(() => {
		if (!animate) return;
		const id = setInterval(() => setActiveStep((s) => (s + 1) % STEPS), intervalMs);
		return () => clearInterval(id);
	}, [animate, intervalMs]);

	return (
		<Box flexDirection="column">
			{ROWS.map((row) => {
				const rowColor = !animate ? color : row.step === activeStep ? color : dimColor;
				return (
					<Text key={`pixc-${row.step}`} bold color={rowColor}>
						{row.text}
					</Text>
				);
			})}
		</Box>
	);
}
