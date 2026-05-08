import { Box, Text, useInput } from "ink";
import { useState } from "react";
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

interface InputProps {
	disabled?: boolean;
	onSubmit: (text: string) => void;
	onAbort?: () => void;
}

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
export function Input({ disabled, onSubmit, onAbort }: InputProps) {
	const [state, setState] = useState(initialInputState());

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			onAbort?.();
			return;
		}

		if (disabled) return;

		if (key.return) {
			const trimmed = state.buffer.trim();
			if (trimmed.length > 0) {
				onSubmit(trimmed);
				setState(initialInputState());
			}
			return;
		}

		// Cursor movement
		if (key.leftArrow) return setState(moveLeft(state));
		if (key.rightArrow) return setState(moveRight(state));
		if (key.ctrl && input === "a") return setState(moveStart(state));
		if (key.ctrl && input === "e") return setState(moveEnd(state));

		// Edits
		if (key.backspace) return setState(backspace(state));
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
			setState(insertChar(state, input));
		}
	});

	return (
		<Box paddingX={1}>
			<Text color={disabled ? "gray" : "cyan"}>{disabled ? "·" : ">"} </Text>
			{disabled ? <Text>{state.buffer}</Text> : <RenderedBuffer buffer={state.buffer} cursor={state.cursor} />}
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
