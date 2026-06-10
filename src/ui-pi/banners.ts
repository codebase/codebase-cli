import { Container, Text } from "@earendil-works/pi-tui";
import { ansi } from "./theme.js";

/**
 * Boxed error card that shows up between transcript and status bar
 * when the agent settles with an error. Ports the ink Status.tsx
 * ErrorCard: a red "ERROR" tag + the first line of the message; the
 * rest of the body (if any) shows dim underneath. Fatal errors need
 * visual weight so they aren't lost in a wall of tool output.
 *
 * Pi-tui has no border primitive, so we draw a single-row red border
 * with box-drawing characters and color the entire row red.
 */
export class ErrorCard extends Container {
	private readonly headLine: Text;
	private readonly bodyLines: Text[];
	private message: string | undefined;

	constructor() {
		super();
		this.headLine = new Text("", 1, 0);
		this.bodyLines = [];
		// Initially empty — show() / hide() toggle the children.
	}

	show(message: string): void {
		this.message = message;
		const lines = message.split("\n");
		const head = lines[0] ?? message;
		const body = lines.slice(1).filter((l) => l.trim().length > 0);
		this.headLine.setText(`${ansi.bold(ansi.red("ERROR"))} ${head}`);

		// Rebuild children: heading + body lines.
		this.clear();
		this.addChild(this.headLine);
		for (const line of body) {
			const t = new Text(ansi.dim(line), 1, 0);
			this.bodyLines.push(t);
			this.addChild(t);
		}
		this.invalidate();
	}

	hide(): void {
		if (!this.message) return;
		this.message = undefined;
		this.clear();
		this.bodyLines.length = 0;
		this.invalidate();
	}

	isVisible(): boolean {
		return this.message !== undefined;
	}
}

/**
 * Context-window warning banner. Mirrors ink Status.tsx
 * ContextWarning — shows when ctx % crosses 85, with a stronger
 * urgent variant at 95+. Tells the user to /compact instead of
 * making them figure out why the next turn keeps stalling.
 */
export class ContextWarning extends Container {
	private readonly line: Text;
	private pct = 0;
	private visible = false;

	constructor() {
		super();
		this.line = new Text("", 1, 0);
	}

	/** Update the percentage; show/hide based on threshold. */
	setPercent(pct: number): void {
		this.pct = pct;
		const shouldShow = pct >= 85;
		if (shouldShow === this.visible) {
			if (shouldShow) this.refresh();
			return;
		}
		this.visible = shouldShow;
		this.clear();
		if (shouldShow) {
			this.refresh();
			this.addChild(this.line);
		}
		this.invalidate();
	}

	private refresh(): void {
		const urgent = this.pct >= 95;
		const glyph = urgent ? "⚠" : "•";
		const color = urgent ? ansi.red : ansi.yellow;
		this.line.setText(
			`${color(ansi.bold(`${glyph} ${this.pct}% of context used`))} ${ansi.dim("— run /compact to free space")}`,
		);
		this.line.invalidate();
	}
}
