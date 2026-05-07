import { Text } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

interface ThrobberProps {
	color?: string;
	intervalMs?: number;
}

/**
 * Self-throttling spinner. Owns its own interval so the parent's reducer
 * state isn't ticked on every frame — a hot stream of message_update events
 * + a 100ms spinner would otherwise compound into needless full re-renders.
 */
export function Throbber({ color = "cyan", intervalMs = 80 }: ThrobberProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setFrame((f) => (f + 1) % FRAMES.length);
		}, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return <Text color={color}>{FRAMES[frame]}</Text>;
}
