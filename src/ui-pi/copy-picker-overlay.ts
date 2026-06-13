import { type Component, Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { CopyEntry } from "./copy-targets.js";
import { ansi, selectListTheme } from "./theme.js";

/** Most recent boxes shown in the picker; older ones drop off the list. */
const MAX_SHOWN = 20;

/**
 * Ctrl-O copy picker. Lists the transcript's copy boxes newest-first
 * (so the thing the agent just produced is pre-selected); Enter copies
 * the chosen box's clean text, Esc cancels. Keyboard-only — no mouse
 * capture, so native select + scroll are untouched.
 */
export class CopyPickerOverlay extends Container {
	private readonly list: SelectList;

	constructor(entries: readonly CopyEntry[], onPick: (entry: CopyEntry) => void, onCancel: () => void) {
		super();
		const recent = [...entries].reverse().slice(0, MAX_SHOWN);
		this.addChild(new Text(ansi.bold(ansi.cyan("Copy which?")), 1, 0));

		const items = recent.map((e) => ({
			value: String(e.id),
			label: e.label,
			description: preview(e.text),
		}));
		this.list = new SelectList(items, Math.min(10, items.length), selectListTheme);
		this.list.onSelect = (item) => {
			const entry = recent.find((e) => String(e.id) === item.value);
			if (entry) onPick(entry);
			else onCancel();
		};
		this.list.onCancel = () => onCancel();
		this.addChild(this.list);
		this.addChild(new Text(ansi.dim("↑↓ Enter to copy · Esc to cancel"), 1, 1));
	}

	getFocusTarget(): Component {
		return this.list;
	}
}

/** One-line preview of a box's content for the picker row. */
function preview(text: string): string {
	const firstLine = text.split("\n")[0] ?? "";
	const extraLines = text.includes("\n") ? ` +${text.split("\n").length - 1} more lines` : "";
	const clipped = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
	return `${clipped}${extraLines}`;
}
