import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MouseSelection } from "./mouse-selection.js";

/**
 * Escapes for full-screen mode: alternate screen + mouse reports for
 * buttons, wheel, and drags (1002 reports motion only while a button is
 * held, so hovering never floods input).
 */
export const ENTER_FULLSCREEN = "\x1b[?1049h\x1b[?1002h\x1b[?1006h";
export const EXIT_FULLSCREEN = "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l";

/** Full-screen is the default; CODEBASE_NO_FULLSCREEN=1 keeps the inline, scrollback-based layout. */
export function fullscreenEnabled(): boolean {
	return process.env.CODEBASE_NO_FULLSCREEN !== "1" && process.stdout.isTTY === true;
}

const WHEEL_LINES = 3;
const BADGE_STYLE = "\x1b[48;5;238m\x1b[38;5;252m";
const JUMP_BADGE = " Jump to bottom (ctrl+End) ↓ ";
const COPIED_BADGE_MS = 1500;
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface ScrollViewportOptions {
	/** Receives the selected text when the user copies it (Ctrl+C with a selection). */
	onCopy?: (text: string) => void;
	/** Asked to repaint when state changes outside input handling (badge timeout). */
	onChange?: () => void;
}

/**
 * Lays the screen out as a scrollable conversation above a pinned footer,
 * always returning exactly `height` lines so pi-tui's line diff repaints
 * in place and nothing spills into terminal scrollback.
 *
 * While following the bottom (the common case, and every streaming frame)
 * only the body components that are actually on screen get rendered,
 * walking up from the newest — cost stays flat as the session grows.
 */
export class ScrollViewport {
	/** First visible body line while scrolled up; undefined = follow the bottom. */
	private anchorTop: number | undefined;
	/** Lines scrolled up but not yet anchored (resolved at the next render). */
	private pendingUp = 0;
	private viewHeight = 10;
	private readonly selection = new MouseSelection();
	/** Rendered conversation rows (tabs expanded), for extracting selected text. */
	private lastView: string[] = [];
	private copiedBadge: string | undefined;
	/** Where the jump-to-bottom badge was painted, so a click on it can jump. */
	private jumpBadgeArea: { row: number; from: number; to: number } | undefined;
	private copiedTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: ScrollViewportOptions = {}) {}

	get following(): boolean {
		return this.anchorTop === undefined && this.pendingUp === 0;
	}

	/** Positive scrolls up (older), negative scrolls down (newer). */
	scroll(lines: number): void {
		if (this.anchorTop === undefined) {
			this.pendingUp = Math.max(0, this.pendingUp + lines);
		} else {
			this.anchorTop = Math.max(0, this.anchorTop - lines);
		}
	}

	scrollToBottom(): void {
		this.anchorTop = undefined;
		this.pendingUp = 0;
	}

	/**
	 * Map an input sequence to a scroll. Returns true when consumed —
	 * every mouse report is swallowed so clicks never type into the editor.
	 * `keys` false leaves PgUp/PgDn to whatever overlay has focus.
	 */
	handleInput(data: string, keys: boolean): boolean {
		const mouse = SGR_MOUSE.exec(data);
		if (mouse) {
			this.handleMouse(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4] === "m");
			return true;
		}
		if (!keys) return false;
		if (this.selection.active && (data === "\x03" || matchesKey(data, "ctrl+c"))) {
			const text = this.selection.text(this.lastView);
			this.selection.clear();
			if (text.trim()) this.copied(text);
			return true;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.scrollToBottom();
			return true;
		}
		const page = Math.max(1, this.viewHeight - 2);
		if (data === "\x1b[5~") {
			this.scroll(page);
			return true;
		}
		if (data === "\x1b[6~") {
			this.scroll(-page);
			return true;
		}
		return false;
	}

	private handleMouse(button: number, col: number, row: number, released: boolean): void {
		if (button & 64) {
			this.selection.clear();
			this.scroll(button & 1 ? -WHEEL_LINES : WHEEL_LINES);
			return;
		}
		if ((button & 3) !== 0) return; // only the left button selects
		const viewRow = Math.min(Math.max(0, row), this.viewHeight - 1);
		const jump = this.jumpBadgeArea;
		if (released) {
			// Keep the highlight; copying waits for Ctrl+C.
			this.selection.release(this.lastView);
		} else if (button & 32) {
			this.selection.drag(viewRow, Math.max(0, col));
		} else if (jump && row === jump.row && col >= jump.from && col < jump.to) {
			this.selection.clear();
			this.scrollToBottom();
		} else if (row < this.viewHeight) {
			this.selection.press(viewRow, Math.max(0, col));
		} else {
			this.selection.clear();
		}
	}

	private copied(text: string): void {
		this.options.onCopy?.(text);
		this.copiedBadge = ` Copied ${text.length.toLocaleString()} character${text.length === 1 ? "" : "s"} `;
		clearTimeout(this.copiedTimer);
		this.copiedTimer = setTimeout(() => {
			this.copiedBadge = undefined;
			this.options.onChange?.();
		}, COPIED_BADGE_MS);
		this.copiedTimer.unref?.();
	}

	render(width: number, height: number, body: readonly Component[], footer: readonly Component[]): string[] {
		// A blank row separates the conversation from the pinned footer.
		const foot: string[] = [""];
		for (const c of footer) foot.push(...c.render(width));
		const viewHeight = Math.max(1, height - foot.length);
		this.viewHeight = viewHeight;

		let view: string[];
		let scrolledUp = false;
		if (this.following) {
			const chunks: string[][] = [];
			let count = 0;
			for (let i = body.length - 1; i >= 0 && count < viewHeight + 2; i--) {
				const lines = body[i].render(width);
				chunks.push(lines);
				count += lines.length;
			}
			view = trimTrailingBlank(chunks.reverse().flat()).slice(-viewHeight);
		} else {
			const all: string[] = [];
			for (const c of body) all.push(...c.render(width));
			trimTrailingBlank(all);
			const maxTop = Math.max(0, all.length - viewHeight);
			if (this.anchorTop === undefined) {
				this.anchorTop = Math.max(0, maxTop - this.pendingUp);
				this.pendingUp = 0;
			}
			if (this.anchorTop >= maxTop) this.scrollToBottom();
			const top = this.anchorTop ?? maxTop;
			view = all.slice(top, top + viewHeight);
			scrolledUp = this.anchorTop !== undefined;
		}

		while (view.length < viewHeight) view.push("");
		view = view.map(expandTabs);
		this.lastView = view;
		view = this.selection.paint(view);
		const badge = this.copiedBadge ?? (scrolledUp ? JUMP_BADGE : undefined);
		this.jumpBadgeArea = undefined;
		if (badge) {
			view[viewHeight - 1] = withBadge(view[viewHeight - 1], badge, width);
			if (badge === JUMP_BADGE) {
				const from = badgeStart(badge, width);
				this.jumpBadgeArea = { row: viewHeight - 1, from, to: from + visibleWidth(badge) };
			}
		}
		// A footer taller than the screen keeps its bottom (the input) visible.
		return [...view, ...foot.map(expandTabs)].slice(-height);
	}
}

/** Centre a badge over a row, keeping the row's text to its left. */
function withBadge(row: string, text: string, width: number): string {
	const badge = `${BADGE_STYLE}${text}\x1b[0m`;
	if (visibleWidth(text) > width) return truncateToWidth(badge, width);
	const start = badgeStart(text, width);
	const left = truncateToWidth(row, start, "");
	return `${left}\x1b[0m${" ".repeat(start - visibleWidth(left))}${badge}`;
}

/** Drop trailing empty rows (each message ends with one) so the footer's blank row is the only gap. */
function trimTrailingBlank(lines: string[]): string[] {
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function badgeStart(text: string, width: number): number {
	return Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
}

/**
 * pi-tui measures a tab as 3 columns but the terminal jumps to the next
 * 8-column stop, so a tabbed line can overflow, wrap, and scroll the whole
 * screen. Expanding to the width pi-tui already measured keeps rows exact.
 */
function expandTabs(line: string): string {
	return line.includes("\t") ? line.replace(/\t/g, "   ") : line;
}
