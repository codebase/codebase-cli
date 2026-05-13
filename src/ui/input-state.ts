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

export interface PastedContent {
	id: number;
	content: string;
	lines: number;
}

export interface InputState {
	buffer: string;
	cursor: number;
	killRing: string[];
	undoStack: Array<{ buffer: string; cursor: number }>;
	lastAction: Action;
	/** Map of paste id → original content for placeholder expansion at submit. */
	pastedContents: Record<number, PastedContent>;
	/** Monotonic counter; next paste in this buffer gets this id. */
	nextPasteId: number;
}

const MAX_UNDO = 100;
const MAX_KILL_RING = 60;

export function initialInputState(): InputState {
	return {
		buffer: "",
		cursor: 0,
		killRing: [],
		undoStack: [],
		lastAction: "init",
		pastedContents: {},
		nextPasteId: 1,
	};
}

/**
 * A useInput tick is a paste rather than a keystroke when it contains a
 * newline (typed `\<Enter>` is handled in the key.return branch, not as
 * printable text — so any `\n` here came from the OS paste buffer) or
 * when it's substantially longer than a normal keystroke / IME chunk.
 */
export function looksLikePaste(input: string): boolean {
	return input.includes("\n") || input.length >= 100;
}

const PASTE_PLACEHOLDER_RE = /\[Pasted #(\d+) · \d+ (?:lines|chars)\]/g;
/** Anchored variants used to detect a placeholder hugging the cursor on either side. */
const PASTE_PLACEHOLDER_RE_END = /\[Pasted #(\d+) · \d+ (?:lines|chars)\]$/;
const PASTE_PLACEHOLDER_RE_START = /^\[Pasted #(\d+) · \d+ (?:lines|chars)\]/;

/**
 * If the buffer slice ending at `pos` finishes with a complete placeholder,
 * return its start offset and id. Used by backspace to delete a whole
 * placeholder atomically instead of chipping at the closing bracket.
 */
function placeholderEndingAt(buffer: string, pos: number): { start: number; id: number } | undefined {
	const before = buffer.slice(0, pos);
	const m = before.match(PASTE_PLACEHOLDER_RE_END);
	if (!m) return undefined;
	return { start: pos - m[0].length, id: Number.parseInt(m[1], 10) };
}

/**
 * If the buffer slice starting at `pos` begins with a complete placeholder,
 * return its end offset and id. Used by deleteForward.
 */
function placeholderStartingAt(buffer: string, pos: number): { end: number; id: number } | undefined {
	const after = buffer.slice(pos);
	const m = after.match(PASTE_PLACEHOLDER_RE_START);
	if (!m) return undefined;
	return { end: pos + m[0].length, id: Number.parseInt(m[1], 10) };
}

function dropPasteEntry(map: Record<number, PastedContent>, id: number): Record<number, PastedContent> {
	if (!(id in map)) return map;
	const next = { ...map };
	delete next[id];
	return next;
}

/**
 * Render the placeholder shown in the visible buffer when text is pasted.
 * Multi-line pastes use a line count; single-line long pastes show char
 * count — different signals for what the user's eye expects to track.
 */
export function formatPastePlaceholder(id: number, content: string): string {
	const lines = content.split("\n").length;
	if (lines > 1) return `[Pasted #${id} · ${lines} lines]`;
	return `[Pasted #${id} · ${content.length} chars]`;
}

/**
 * Stash pasted content under a fresh id and insert a placeholder at the
 * cursor. The buffer stays short and readable; the real text re-inflates
 * at submit via expandPastes(). Pastes follow normal insertChar undo
 * snapshots — Ctrl-Z will pop the placeholder *and* the side entry stays
 * in pastedContents, harmless because nothing will reference it.
 */
export function insertPaste(state: InputState, content: string): InputState {
	if (!content) return state;
	const id = state.nextPasteId;
	const placeholder = formatPastePlaceholder(id, content);
	const inserted = insertChar(state, placeholder);
	return {
		...inserted,
		pastedContents: {
			...state.pastedContents,
			[id]: { id, content, lines: content.split("\n").length },
		},
		nextPasteId: id + 1,
	};
}

/**
 * Replace `[Pasted #N · ...]` placeholders with their original content.
 * Called at submit time so the agent sees the real text. Orphaned ids
 * (placeholder deleted out of the buffer) are silently dropped — only
 * the ones still present in the buffer expand. Placeholders we don't
 * recognize (e.g. user typed something that matches the pattern) pass
 * through unchanged so we don't corrupt their literal input.
 */
export function expandPastes(buffer: string, pastedContents: Record<number, PastedContent>): string {
	return buffer.replace(PASTE_PLACEHOLDER_RE, (match, idStr) => {
		const id = Number.parseInt(idStr, 10);
		const entry = pastedContents[id];
		return entry ? entry.content : match;
	});
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
	// Atomic placeholder delete: backspacing at the right edge of a paste
	// placeholder removes the whole placeholder instead of breaking off
	// the closing bracket and leaving a fragment that won't re-expand.
	const ph = placeholderEndingAt(state.buffer, state.cursor);
	if (ph) {
		return {
			...state,
			buffer: state.buffer.slice(0, ph.start) + state.buffer.slice(state.cursor),
			cursor: ph.start,
			pastedContents: dropPasteEntry(state.pastedContents, ph.id),
			undoStack: pushUndo(state),
			lastAction: "delete",
		};
	}
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
	// Atomic placeholder delete on forward-delete from the left edge.
	const ph = placeholderStartingAt(state.buffer, state.cursor);
	if (ph) {
		return {
			...state,
			buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(ph.end),
			pastedContents: dropPasteEntry(state.pastedContents, ph.id),
			undoStack: pushUndo(state),
			lastAction: "delete",
		};
	}
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
