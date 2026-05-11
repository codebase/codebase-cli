import { Text } from "ink";
import { useEffect, useState } from "react";

/**
 * 8-frame pulse cycle — the codebase pixel-C "scanning" through brightness
 * levels. The compact (1-char) variant cycles a single block-glyph: ░▒▓█▓▒░.
 * The full pixel-C variant scans a highlight row across the C shape.
 *
 * Self-throttling: owns its own interval so the parent's reducer state
 * doesn't tick on every frame. A hot message_update stream + a 100ms
 * spinner would otherwise compound into full re-renders 10× a second.
 */

const COMPACT_FRAMES = ["░", "▒", "▓", "█", "█", "▓", "▒", "░"];

interface ThrobberProps {
	color?: string;
	intervalMs?: number;
}

export function Throbber({ color = "cyan", intervalMs = 90 }: ThrobberProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setFrame((f) => (f + 1) % COMPACT_FRAMES.length);
		}, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return <Text color={color}>{COMPACT_FRAMES[frame]}</Text>;
}
