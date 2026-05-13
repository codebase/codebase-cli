import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { CompactionState } from "../compaction/monitor.js";

/**
 * Visible banner while the agent is summarising older turns into a
 * compaction checkpoint. The work itself takes a few seconds on long
 * sessions — silent before, looked like a hang. The banner re-renders
 * its elapsed-seconds label every second so the user has a clear
 * "still working" signal.
 */
export function CompactionBanner({ state }: { state: CompactionState }) {
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!state.startedAt) return;
		const tick = () => setElapsed(Math.floor((Date.now() - (state.startedAt ?? Date.now())) / 1000));
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [state.startedAt]);
	return (
		<Box paddingX={1} marginBottom={0}>
			<Text color="yellow">
				⟳ Compacting context ({state.messageCount} messages
				{elapsed > 0 ? ` · ${elapsed}s` : ""})…
			</Text>
		</Box>
	);
}
