import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { RewindPoint } from "../agent/conversation-rewind.js";
import { ansi, selectListTheme } from "./theme.js";

/**
 * Overlay for /rewind (no args) — lists prior user prompts newest-first
 * and rewinds the conversation (and matching file edits) to just before
 * the chosen one. Esc cancels without touching state.
 */
export class RewindOverlay extends Container {
	private readonly list: SelectList;

	constructor(points: RewindPoint[], onSelect: (point: RewindPoint) => void, onCancel: () => void) {
		super();

		this.addChild(new Text(ansi.bold("Rewind conversation"), 1, 0));
		this.addChild(new Text(ansi.dim("↑↓ choose · Enter rewind to before · Esc cancel"), 1, 0));

		// Newest first so the most recent prompt is at the top, where the
		// cursor starts — the common case is "undo my last message".
		const ordered = [...points].reverse();
		const items = ordered.map((p, i) => ({
			value: String(p.index),
			label: p.preview,
			description: i === 0 ? "most recent prompt" : `${i} prompt${i === 1 ? "" : "s"} back`,
		}));

		this.list = new SelectList(items, Math.min(12, Math.max(4, items.length)), selectListTheme);
		this.list.onSelect = (item) => {
			const idx = Number.parseInt(String(item.value), 10);
			const point = points.find((p) => p.index === idx);
			if (point) onSelect(point);
		};
		this.list.onCancel = onCancel;
		this.addChild(this.list);
	}

	getFocusTarget(): SelectList {
		return this.list;
	}
}
