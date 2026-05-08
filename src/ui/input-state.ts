/**
 * Pure state machine for the input editor. Pulled out of the React
 * component so we can unit-test cursor / kill-ring / undo behavior
 * without standing up an Ink instance.
 *
 * Conventions match Emacs / readline so muscle memory transfers:
 *   Ctrl-A / Ctrl-E      → start / end of line
 *   Ctrl-K / Ctrl-U      → kill to end / kill to start
 *   Ctrl-W               → kill word before cursor
 *   Ctrl-D / Backspace   → delete forward / backward
 *   Ctrl-Y               → yank (paste from kill ring)
 *   Ctrl-Z               → undo
 *
 * The kill ring follows the Emacs accumulation rule: consecutive kills
 * concatenate into a single ring entry; any non-kill action breaks the
 * chain so the next kill starts a fresh entry.
 */

export type Action = "type" | "kill" | "yank" | "delete" | "move" | "undo" | "init";

export interface InputState {
	buffer: string;
	cursor: number;
	killRing: string[];
	undoStack: Array<{ buffer: string; cursor: number }>;
	lastAction: Action;
}

const MAX_UNDO = 100;
const MAX_KILL_RING = 60;

export function initialInputState(): InputState {
	return { buffer: "", cursor: 0, killRing: [], undoStack: [], lastAction: "init" };
}

export function setBuffer(state: InputState, buffer: string): InputState {
	const cursor = Math.min(state.cursor, buffer.length);
	return { ...state, buffer, cursor, lastAction: "type" };
}

export function insertChar(state: InputState, ch: string): InputState {
	if (!ch) return state;
	const next: InputState = {
		...state,
		buffer: state.buffer.slice(0, state.cursor) + ch + state.buffer.slice(state.cursor),
		cursor: state.cursor + ch.length,
	};
	// Snapshot only at boundary transitions so a long type doesn't fill the stack.
	if (state.lastAction !== "type") {
		next.undoStack = pushUndo(state);
	} else {
		next.undoStack = state.undoStack;
	}
	next.lastAction = "type";
	return next;
}

export function backspace(state: InputState): InputState {
	if (state.cursor === 0) return state;
	return {
		...state,
		buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor),
		cursor: state.cursor - 1,
		undoStack: pushUndo(state),
		lastAction: "delete",
	};
}

export function deleteForward(state: InputState): InputState {
	if (state.cursor >= state.buffer.length) return state;
	return {
		...state,
		buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1),
		undoStack: pushUndo(state),
		lastAction: "delete",
	};
}

export function moveLeft(state: InputState): InputState {
	if (state.cursor === 0) return { ...state, lastAction: "move" };
	return { ...state, cursor: state.cursor - 1, lastAction: "move" };
}

export function moveRight(state: InputState): InputState {
	if (state.cursor >= state.buffer.length) return { ...state, lastAction: "move" };
	return { ...state, cursor: state.cursor + 1, lastAction: "move" };
}

export function moveStart(state: InputState): InputState {
	return { ...state, cursor: 0, lastAction: "move" };
}

export function moveEnd(state: InputState): InputState {
	return { ...state, cursor: state.buffer.length, lastAction: "move" };
}

export function killToEnd(state: InputState): InputState {
	if (state.cursor >= state.buffer.length) return state;
	const killed = state.buffer.slice(state.cursor);
	return {
		...state,
		buffer: state.buffer.slice(0, state.cursor),
		killRing: appendToKill(state, killed, "after"),
		undoStack: pushUndo(state),
		lastAction: "kill",
	};
}

export function killToStart(state: InputState): InputState {
	if (state.cursor === 0) return state;
	const killed = state.buffer.slice(0, state.cursor);
	return {
		...state,
		buffer: state.buffer.slice(state.cursor),
		cursor: 0,
		killRing: appendToKill(state, killed, "before"),
		undoStack: pushUndo(state),
		lastAction: "kill",
	};
}

export function killWordBack(state: InputState): InputState {
	if (state.cursor === 0) return state;
	const wordStart = findWordBoundaryBack(state.buffer, state.cursor);
	const killed = state.buffer.slice(wordStart, state.cursor);
	if (!killed) return state;
	return {
		...state,
		buffer: state.buffer.slice(0, wordStart) + state.buffer.slice(state.cursor),
		cursor: wordStart,
		killRing: appendToKill(state, killed, "before"),
		undoStack: pushUndo(state),
		lastAction: "kill",
	};
}

export function killWordForward(state: InputState): InputState {
	if (state.cursor >= state.buffer.length) return state;
	const wordEnd = findWordBoundaryForward(state.buffer, state.cursor);
	const killed = state.buffer.slice(state.cursor, wordEnd);
	if (!killed) return state;
	return {
		...state,
		buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(wordEnd),
		killRing: appendToKill(state, killed, "after"),
		undoStack: pushUndo(state),
		lastAction: "kill",
	};
}

export function yank(state: InputState): InputState {
	const top = state.killRing[state.killRing.length - 1];
	if (!top) return state;
	return {
		...state,
		buffer: state.buffer.slice(0, state.cursor) + top + state.buffer.slice(state.cursor),
		cursor: state.cursor + top.length,
		undoStack: pushUndo(state),
		lastAction: "yank",
	};
}

export function undo(state: InputState): InputState {
	if (state.undoStack.length === 0) return state;
	const prev = state.undoStack[state.undoStack.length - 1];
	return {
		...state,
		buffer: prev.buffer,
		cursor: prev.cursor,
		undoStack: state.undoStack.slice(0, -1),
		lastAction: "undo",
	};
}

export function reset(): InputState {
	return initialInputState();
}

// ─── helpers ─────────────────────────────────────────────────

function pushUndo(state: InputState): InputState["undoStack"] {
	const snapshot = { buffer: state.buffer, cursor: state.cursor };
	const next = [...state.undoStack, snapshot];
	return next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next;
}

/**
 * Append `killed` to the most recent kill-ring entry if the previous
 * action was also a kill (Emacs convention); otherwise push a new
 * entry. `direction` controls whether this kill is concatenated before
 * or after the existing entry — Ctrl-W/Backward kills prepend, Ctrl-K
 * forward kills append.
 */
function appendToKill(state: InputState, killed: string, direction: "before" | "after"): string[] {
	const ring = state.killRing.slice();
	if (state.lastAction === "kill" && ring.length > 0) {
		const head = ring[ring.length - 1];
		ring[ring.length - 1] = direction === "before" ? killed + head : head + killed;
	} else {
		ring.push(killed);
		if (ring.length > MAX_KILL_RING) ring.shift();
	}
	return ring;
}

const WORD_CHAR_RE = /[A-Za-z0-9_]/;

function findWordBoundaryBack(buffer: string, from: number): number {
	let i = from;
	// Skip non-word chars first
	while (i > 0 && !WORD_CHAR_RE.test(buffer[i - 1])) i--;
	// Then skip word chars
	while (i > 0 && WORD_CHAR_RE.test(buffer[i - 1])) i--;
	return i;
}

function findWordBoundaryForward(buffer: string, from: number): number {
	let i = from;
	while (i < buffer.length && !WORD_CHAR_RE.test(buffer[i])) i++;
	while (i < buffer.length && WORD_CHAR_RE.test(buffer[i])) i++;
	return i;
}
