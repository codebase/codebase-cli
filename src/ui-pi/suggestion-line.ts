import { Container, Text } from "@earendil-works/pi-tui";
import { ansi } from "./theme.js";

/**
 * Ghost prompt-suggestion line rendered above the editor — pi-tui's
 * Editor has no inline ghost-text slot, so the forecast lives on its own
 * dim line. Tab accepts it into the (empty) editor; any other keystroke
 * dismisses it. App owns the scheduling; this just displays.
 */
export class SuggestionLine extends Container {
	private current: string | undefined;

	set(text: string | undefined): void {
		if (text === this.current) return;
		this.current = text;
		this.clear();
		if (text) {
			this.addChild(new Text(ansi.dim(`▸ ${text}   — Tab to accept`), 1, 0));
		}
		this.invalidate();
	}

	get(): string | undefined {
		return this.current;
	}
}
