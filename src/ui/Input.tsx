import { Box, Text, useInput } from "ink";
import { useMemo, useRef, useState } from "react";
import { completePath, findAtTokenAt } from "./path-complete.js";
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
	/**
	 * Prior user inputs, chronological (oldest first). Navigated with ↑/↓
	 * when the slash-command popup is closed and the cursor is at the
	 * start of the buffer (or the buffer is empty).
	 */
	history?: readonly string[];
	/** Working directory used to resolve @-token Tab completion. */
	cwd?: string;
}

const MAX_SUGGESTIONS = 6;

const PLACEHOLDERS_FRESH = [
	"Ask anything · / for commands",
	"Try /help to see what I can do",
	"Tell me what to build · / for commands",
	"Paste a stack trace, a TODO, or a question",
	"What are we working on?",
];

const PLACEHOLDERS_RETURNING = [
	"Welcome back · ↑ for prior prompts",
	"Picking up where you left off · ↑ for history",
	"What's next? · ↑ recalls past prompts",
	"Ready when you are · / for commands · ↑ for history",
];

/**
 * Pick a placeholder once per Input mount. The returning-user variants
 * mention ↑ for history so users with persisted prompts learn the
 * shortcut; fresh sessions emphasize / and free-form prompts.
 */
function pickPlaceholder(hasHistory: boolean): string {
	const pool = hasHistory ? PLACEHOLDERS_RETURNING : PLACEHOLDERS_FRESH;
	return pool[Math.floor(Math.random() * pool.length)];
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
export function Input({ disabled, onSubmit, onAbort, commands, history, cwd }: InputProps) {
	const [state, setState] = useState(initialInputState());
	const [suggestionIdx, setSuggestionIdx] = useState(0);
	/**
	 * History cursor:
	 *   -1            → live buffer (no history navigation in progress)
	 *   0..N-1        → indexing from the newest backwards (0 = most recent)
	 * We snapshot the live buffer the first time the user steps into
	 * history so ↓-past-newest returns to whatever they were typing.
	 */
	const [historyIdx, setHistoryIdx] = useState(-1);
	const [liveBuffer, setLiveBuffer] = useState<string | null>(null);
	// Stable per-mount placeholder so the hint doesn't flicker between renders.
	const placeholderRef = useRef<string>(pickPlaceholder((history?.length ?? 0) > 0));

	// @-path completion cycler — `pathMatches` is the list, `pathIdx` is
	// the current cycle position. Both reset whenever the buffer
	// changes away from the active @-token.
	const [pathMatches, setPathMatches] = useState<string[]>([]);
	const [pathIdx, setPathIdx] = useState(0);
	const lastAtTokenRef = useRef<{ buffer: string; cursor: number } | null>(null);

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

		// @-path Tab completion. Only kicks in when slash autocomplete is
		// inactive and the cursor sits inside an @-token. Repeated Tab
		// cycles through matches; any keypress other than Tab clears the
		// cycle so the next Tab recomputes a fresh list.
		if (key.tab && !autocompleteActive && cwd) {
			const at = findAtTokenAt(state.buffer, state.cursor);
			if (at) {
				let matches = pathMatches;
				let idx = pathIdx;
				const cached = lastAtTokenRef.current;
				const sameContext =
					cached && cached.buffer === state.buffer && cached.cursor === state.cursor && matches.length > 0;
				if (!sameContext) {
					matches = completePath(at.prefix, cwd);
					idx = 0;
					setPathMatches(matches);
					setPathIdx(0);
				} else {
					idx = (idx + 1) % matches.length;
					setPathIdx(idx);
				}
				if (matches.length === 0) return;
				const chosen = matches[idx];
				const before = state.buffer.slice(0, at.start);
				const after = state.buffer.slice(state.cursor);
				const inserted = `@${chosen}`;
				const newBuffer = before + inserted + after;
				const newCursor = before.length + inserted.length;
				setState({ ...initialInputState(), buffer: newBuffer, cursor: newCursor });
				lastAtTokenRef.current = { buffer: newBuffer, cursor: newCursor };
				return;
			}
		}

		// History navigation: only when autocomplete is closed and the
		// cursor sits at the start of the buffer (or buffer is empty).
		// That way ↑/↓ in the middle of a long line still behave as
		// cursor moves, matching shell readline.
		if (history && history.length > 0 && !autocompleteActive && state.cursor === 0) {
			if (key.upArrow) {
				const nextIdx = historyIdx < 0 ? 0 : Math.min(historyIdx + 1, history.length - 1);
				if (historyIdx < 0) setLiveBuffer(state.buffer);
				const entry = history[history.length - 1 - nextIdx] ?? "";
				setHistoryIdx(nextIdx);
				setState({ ...initialInputState(), buffer: entry, cursor: entry.length });
				return;
			}
			if (key.downArrow) {
				if (historyIdx < 0) return; // already at live buffer
				const nextIdx = historyIdx - 1;
				if (nextIdx < 0) {
					const restored = liveBuffer ?? "";
					setHistoryIdx(-1);
					setLiveBuffer(null);
					setState({ ...initialInputState(), buffer: restored, cursor: restored.length });
				} else {
					const entry = history[history.length - 1 - nextIdx] ?? "";
					setHistoryIdx(nextIdx);
					setState({ ...initialInputState(), buffer: entry, cursor: entry.length });
				}
				return;
			}
		}

		// Esc clears the buffer back to empty (and exits history mode) so
		// the user can bail out of a half-typed prompt without having to
		// hammer Backspace. Matches CC's behavior; harmless when empty.
		if (key.escape) {
			if (state.buffer.length === 0 && historyIdx < 0) return;
			setState(initialInputState());
			setSuggestionIdx(0);
			setHistoryIdx(-1);
			setLiveBuffer(null);
			return;
		}

		if (key.return) {
			// `\<Enter>` inserts a newline instead of submitting — the CC
			// convention for multi-line input. Strip the trailing `\` and
			// replace it with a newline so the buffer reads cleanly.
			if (state.buffer.endsWith("\\") && state.cursor === state.buffer.length) {
				const stripped = state.buffer.slice(0, -1);
				setState({ ...initialInputState(), buffer: `${stripped}\n`, cursor: stripped.length + 1 });
				return;
			}
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
				setHistoryIdx(-1);
				setLiveBuffer(null);
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
		// Ctrl-D matches readline: on an empty buffer it's EOF (i.e. quit),
		// on a non-empty buffer it deletes forward like Delete.
		if (key.ctrl && input === "d") {
			if (state.buffer.length === 0) {
				onAbort?.();
				return;
			}
			return setState(deleteForward(state));
		}

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
			// Once the user starts editing on top of a recalled history
			// entry, snap out of history mode — the entry is now their
			// own buffer and ↓ shouldn't try to bring it back.
			if (historyIdx >= 0) {
				setHistoryIdx(-1);
				setLiveBuffer(null);
			}
			// Break the @-Tab cycle so the next Tab recomputes from the new text.
			if (pathMatches.length > 0) {
				setPathMatches([]);
				setPathIdx(0);
				lastAtTokenRef.current = null;
			}
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
				{disabled ? (
					<Text>{state.buffer}</Text>
				) : state.buffer.length === 0 ? (
					<>
						<Text color="cyan">▎</Text>
						<Text dimColor>{placeholderRef.current}</Text>
					</>
				) : (
					<RenderedBuffer buffer={state.buffer} cursor={state.cursor} />
				)}
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
 * Splits on `\n` so multi-line pastes (and `\<Enter>` newlines) show
 * as stacked rows — otherwise pasted code collapses into one line and
 * the user can't see what they're sending.
 */
function RenderedBuffer({ buffer, cursor }: RenderedBufferProps) {
	if (!buffer.includes("\n")) return <SingleLineBuffer buffer={buffer} cursor={cursor} />;
	const lines = buffer.split("\n");
	let consumed = 0;
	return (
		<Box flexDirection="column">
			{lines.map((line, idx) => {
				const lineStart = consumed;
				const lineEnd = consumed + line.length;
				const cursorOnThisLine = cursor >= lineStart && cursor <= lineEnd;
				consumed = lineEnd + 1;
				if (!cursorOnThisLine) {
					return (
						<Text key={`line-${idx}-${line.slice(0, 8)}`}>{line.length === 0 ? " " : line}</Text>
					);
				}
				return (
					<SingleLineBuffer
						key={`line-${idx}-cur-${line.slice(0, 8)}`}
						buffer={line}
						cursor={cursor - lineStart}
					/>
				);
			})}
		</Box>
	);
}

function SingleLineBuffer({ buffer, cursor }: RenderedBufferProps) {
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
