import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { displayLine, filterHistory, searchCandidates } from "./history-search-core.js";

export interface HistorySearchProps {
	/** Chronological prompt history (oldest first), as kept by App. */
	history: readonly string[];
	onPick: (text: string) => void;
	onCancel: () => void;
}

const MAX_SHOWN = 8;

/**
 * Ctrl-R reverse history search. Type to filter past prompts (newest
 * first, deduplicated); ↑↓ or repeated Ctrl-R move the selection; Enter
 * drops the pick into the input buffer; Esc cancels.
 */
export function HistorySearch({ history, onPick, onCancel }: HistorySearchProps) {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);

	const candidates = useMemo(() => searchCandidates(history), [history]);
	const matches = useMemo(() => filterHistory(candidates, query), [candidates, query]);

	const clamped = Math.min(cursor, Math.max(0, matches.length - 1));

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.return) {
			if (matches[clamped]) onPick(matches[clamped]);
			else onCancel();
			return;
		}
		// Repeated Ctrl-R steps to the next-older match, readline-style.
		if ((key.ctrl && input === "r") || key.downArrow) {
			setCursor((c) => (matches.length === 0 ? 0 : (Math.min(c, matches.length - 1) + 1) % matches.length));
			return;
		}
		if (key.upArrow) {
			setCursor((c) =>
				matches.length === 0 ? 0 : (Math.min(c, matches.length - 1) - 1 + matches.length) % matches.length,
			);
			return;
		}
		if (key.backspace || key.delete) {
			setQuery((q) => q.slice(0, -1));
			setCursor(0);
			return;
		}
		if (input && !key.ctrl && !key.meta) {
			setQuery((q) => q + input);
			setCursor(0);
		}
	});

	const shownStart = Math.max(0, Math.min(clamped - 2, matches.length - MAX_SHOWN));
	const shown = matches.slice(shownStart, shownStart + MAX_SHOWN);

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text>
				<Text color="cyan">(reverse-i-search)</Text> <Text>{query}</Text>
				<Text color="magenta">▎</Text>
			</Text>
			{matches.length === 0 ? (
				<Text dimColor> no matching prompts</Text>
			) : (
				shown.map((m, i) => {
					const idx = shownStart + i;
					const selected = idx === clamped;
					const line = displayLine(m);
					return (
						<Text key={`${idx}-${m.slice(0, 20)}`}>
							<Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
							<Text bold={selected}>{line}</Text>
						</Text>
					);
				})
			)}
			<Text dimColor>Enter to use · ↑↓/Ctrl-R to move · Esc to cancel</Text>
		</Box>
	);
}
