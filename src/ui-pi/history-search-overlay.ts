import { type Component, Container, Input, Text } from "@earendil-works/pi-tui";
import { displayLine, filterHistory, searchCandidates } from "../ui/history-search-core.js";
import { ansi } from "./theme.js";

const MAX_SHOWN = 8;

/**
 * Ctrl-R reverse history search overlay. Typing filters past prompts
 * (newest first, deduplicated); ↑↓ or repeated Ctrl-R move the
 * selection; Enter hands the pick back; Esc cancels.
 */
export class HistorySearchOverlay extends Container {
	private readonly candidates: readonly string[];
	private readonly input: SearchInput;
	private cursor = 0;
	private readonly onPick: (text: string) => void;
	private readonly onCancel: () => void;

	constructor(history: readonly string[], onPick: (text: string) => void, onCancel: () => void) {
		super();
		this.onPick = onPick;
		this.onCancel = onCancel;
		this.candidates = searchCandidates(history);

		this.input = new SearchInput();
		this.input.onChanged = () => {
			this.cursor = 0;
			this.rebuild();
		};
		this.input.onNavigate = (delta) => {
			const total = this.matches().length;
			if (total > 0) this.cursor = (this.cursor + delta + total) % total;
			this.rebuild();
		};
		this.input.onSubmit = () => {
			const picked = this.matches()[this.cursor];
			if (picked) this.onPick(picked);
			else this.onCancel();
		};
		this.input.onEscape = () => this.onCancel();
		this.rebuild();
	}

	getFocusTarget(): Component {
		return this.input;
	}

	private matches(): string[] {
		return filterHistory(this.candidates, this.input.getValue());
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(ansi.bold(ansi.cyan("(reverse-i-search)")), 1, 0));
		this.addChild(this.input);
		const matches = this.matches();
		this.cursor = Math.min(this.cursor, Math.max(0, matches.length - 1));
		if (matches.length === 0) {
			this.addChild(new Text(ansi.dim("  no matching prompts"), 1, 0));
		} else {
			const start = Math.max(0, Math.min(this.cursor - 2, matches.length - MAX_SHOWN));
			for (let i = start; i < Math.min(start + MAX_SHOWN, matches.length); i++) {
				const selected = i === this.cursor;
				const line = displayLine(matches[i]);
				this.addChild(new Text(selected ? `${ansi.cyan("▸ ")}${ansi.bold(line)}` : ansi.dim(`  ${line}`), 1, 0));
			}
		}
		this.addChild(new Text(ansi.dim("Enter to use · ↑↓/Ctrl-R to move · Esc to cancel"), 1, 1));
		this.invalidate();
	}
}

/**
 * Input that reports edits (for live filtering) and intercepts the
 * navigation keys before the base class can treat them as cursor moves.
 */
class SearchInput extends Input {
	onChanged?: () => void;
	onNavigate?: (delta: 1 | -1) => void;

	override handleInput(data: string): void {
		if (data === "\x1b[A") {
			this.onNavigate?.(-1);
			return;
		}
		if (data === "\x1b[B" || data === "\x12") {
			this.onNavigate?.(1);
			return;
		}
		const before = this.getValue();
		super.handleInput(data);
		if (this.getValue() !== before) this.onChanged?.();
	}
}
