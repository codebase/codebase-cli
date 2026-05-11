import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import {
	backspace,
	deleteForward,
	initialInputState,
	insertChar,
	killToEnd,
	killToStart,
	killWordBack,
	moveEnd,
	moveLeft,
	moveRight,
	moveStart,
	undo,
	yank,
} from "./input-state.js";

export interface SlashCommandSuggestion {
	name: string;
	description?: string;
}

interface InputProps {
	disabled?: boolean;
	onSubmit: (text: string) => void;
	onAbort?: () => void;
	/** Slash command list for autocomplete. Optional; without it, autocomplete is off. */
	commands?: readonly SlashCommandSuggestion[];
}

const MAX_SUGGESTIONS = 6;

/**
 * Single-line input with Emacs / readline editing. Cursor positioning,
 * kill ring with Ctrl-K/U/W/Y, and Ctrl-Z undo. Stay in tight feedback
 * with the user — every keystroke runs through the pure input-state
 * reducer so the editing semantics are unit-testable.
 *
 * Keys:
 *   Enter           submit (empty input is dropped)
 *   Backspace/Del   delete char before / after cursor
 *   ←/→             move cursor by one
 *   Ctrl-A / Ctrl-E start / end of line
 *   Ctrl-K          kill from cursor to end of line
 *   Ctrl-U          kill from start of line to cursor
 *   Ctrl-W          kill word before cursor
 *   Ctrl-Y          yank (paste from kill ring)
 *   Ctrl-Z          undo
 *   Ctrl-C          abort (busy → cancel turn, idle → exit app)
 */
export function Input({ disabled, onSubmit, onAbort, commands }: InputProps) {
	const [state, setState] = useState(initialInputState());
	const [suggestionIdx, setSuggestionIdx] = useState(0);

	// Autocomplete only fires when the buffer starts with `/` AND there's
	// no whitespace yet (so once the user types a space, they're past the
	// command name and into args — no more suggestions).
	const autocompleteActive = state.buffer.startsWith("/") && !state.buffer.includes(" ");

	const suggestions = useMemo(() => {
		if (!autocompleteActive || !commands) return [];
		const query = state.buffer.slice(1).toLowerCase();
		const matches = commands.filter((c) => c.name.toLowerCase().startsWith(query));
		return matches.slice(0, MAX_SUGGESTIONS);
	}, [autocompleteActive, commands, state.buffer]);

	const clampedSuggestionIdx = Math.min(suggestionIdx, Math.max(0, suggestions.length - 1));

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			onAbort?.();
			return;
		}

		if (disabled) return;

		// Autocomplete navigation runs BEFORE generic input handling so Tab
		// doesn't insert a literal tab and arrow keys don't fight cursor
		// movement when we have a suggestion list to navigate.
		if (autocompleteActive && suggestions.length > 0) {
			if (key.upArrow) {
				setSuggestionIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
				return;
			}
			if (key.downArrow) {
				setSuggestionIdx((i) => (i + 1) % suggestions.length);
				return;
			}
			if (key.tab) {
				const chosen = suggestions[clampedSuggestionIdx];
				setState({ ...initialInputState(), buffer: `/${chosen.name} `, cursor: chosen.name.length + 2 });
				setSuggestionIdx(0);
				return;
			}
		}

		if (key.return) {
			// Enter on a single-suggestion autocomplete still submits — if
			// the user wanted to complete, they'd Tab. If they hit Enter on
			// `/cos`, that's a clear "run /cost" intent only if it's an
			// exact match; otherwise we submit as-typed and let the command
			// registry's not-found path surface the typo.
			const trimmed = state.buffer.trim();
			if (trimmed.length > 0) {
				onSubmit(trimmed);
				setState(initialInputState());
				setSuggestionIdx(0);
			}
			return;
		}

		// Cursor movement
		if (key.leftArrow) return setState(moveLeft(state));
		if (key.rightArrow) return setState(moveRight(state));
		if (key.ctrl && input === "a") return setState(moveStart(state));
		if (key.ctrl && input === "e") return setState(moveEnd(state));

		// Edits
		if (key.backspace) {
			setSuggestionIdx(0);
			return setState(backspace(state));
		}
		if (key.delete) return setState(deleteForward(state));
		if (key.ctrl && input === "d") return setState(deleteForward(state));

		// Kill ring
		if (key.ctrl && input === "k") return setState(killToEnd(state));
		if (key.ctrl && input === "u") return setState(killToStart(state));
		if (key.ctrl && input === "w") return setState(killWordBack(state));
		if (key.ctrl && input === "y") return setState(yank(state));

		// Undo
		if (key.ctrl && input === "z") return setState(undo(state));

		// Printable text — Ink's useInput delivers individual chars (or pasted runs)
		if (input && !key.ctrl && !key.meta) {
			setSuggestionIdx(0);
			setState(insertChar(state, input));
		}
	});

	return (
		<Box flexDirection="column">
			{autocompleteActive && suggestions.length > 0 ? (
				<SlashSuggestions suggestions={suggestions} selected={clampedSuggestionIdx} />
			) : null}
			<Box paddingX={1}>
				<Text color={disabled ? "gray" : "cyan"}>{disabled ? "·" : ">"} </Text>
				{disabled ? <Text>{state.buffer}</Text> : <RenderedBuffer buffer={state.buffer} cursor={state.cursor} />}
			</Box>
		</Box>
	);
}

function SlashSuggestions({
	suggestions,
	selected,
}: {
	suggestions: readonly SlashCommandSuggestion[];
	selected: number;
}) {
	return (
		<Box flexDirection="column" paddingX={1} marginBottom={0}>
			{suggestions.map((cmd, i) => {
				const isSelected = i === selected;
				return (
					<Box key={`sug-${cmd.name}`}>
						<Text color={isSelected ? "cyan" : "gray"} bold={isSelected}>
							{isSelected ? "▸ " : "  "}
							{`/${cmd.name}`}
						</Text>
						{cmd.description ? (
							<Text dimColor>
								{"  "}— {cmd.description.slice(0, 60)}
							</Text>
						) : null}
					</Box>
				);
			})}
			<Box marginTop={0}>
				<Text dimColor>↑↓ to move · Tab to complete · Enter to send as-typed</Text>
			</Box>
		</Box>
	);
}

interface RenderedBufferProps {
	buffer: string;
	cursor: number;
}

/**
 * Render the buffer with a visible cursor block at the cursor position.
 * Inverse-video on the character under the cursor, or a thin block at
 * end-of-line. Keeps the layout stable so the line doesn't shift when
 * the cursor crosses the boundary.
 */
function RenderedBuffer({ buffer, cursor }: RenderedBufferProps) {
	if (cursor >= buffer.length) {
		return (
			<>
				<Text>{buffer}</Text>
				<Text color="cyan">▎</Text>
			</>
		);
	}
	const before = buffer.slice(0, cursor);
	const onCursor = buffer[cursor] === " " ? " " : (buffer[cursor] ?? " ");
	const after = buffer.slice(cursor + 1);
	return (
		<>
			<Text>{before}</Text>
			<Text inverse>{onCursor}</Text>
			<Text>{after}</Text>
		</>
	);
}
