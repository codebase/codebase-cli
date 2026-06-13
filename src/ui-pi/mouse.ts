/**
 * SGR mouse-event parsing (DECSET 1006). When mouse reporting is on, the
 * terminal sends `\x1b[<button;col;row(M|m)>` — M = press, m = release.
 * pi-tui's stdin buffer already frames these as whole chunks, so we just
 * decode the one string the input listener hands us.
 *
 * Button encoding: low 2 bits select left/middle/right; bit 2 (4) = shift,
 * bit 3 (8) = meta, bit 4 (16) = ctrl; bit 5 (32) = motion; bit 6 (64) =
 * wheel (64 = up, 65 = down). col/row are 1-based from the top-left of the
 * terminal viewport.
 */

export interface MouseEvent {
	kind: "press" | "release";
	/** 0 = left, 1 = middle, 2 = right; undefined for wheel events. */
	button?: 0 | 1 | 2;
	wheel?: "up" | "down";
	/** 1-based viewport column. */
	col: number;
	/** 1-based viewport row. */
	row: number;
	shift: boolean;
	motion: boolean;
}

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** True if `data` looks like the start of an SGR mouse sequence (for consume gating). */
export function isMouseSequence(data: string): boolean {
	return data.startsWith("\x1b[<");
}

export function parseMouseEvent(data: string): MouseEvent | null {
	const m = SGR_MOUSE.exec(data);
	if (!m) return null;
	const b = Number.parseInt(m[1], 10);
	const col = Number.parseInt(m[2], 10);
	const row = Number.parseInt(m[3], 10);
	const kind = m[4] === "M" ? "press" : "release";
	const isWheel = (b & 64) !== 0;
	const event: MouseEvent = {
		kind,
		col,
		row,
		shift: (b & 4) !== 0,
		motion: (b & 32) !== 0,
	};
	if (isWheel) {
		event.wheel = (b & 1) === 0 ? "up" : "down";
	} else {
		event.button = (b & 3) as 0 | 1 | 2;
	}
	return event;
}

/** A plain (no-shift) left-button press — the gesture we treat as a click. */
export function isLeftClick(event: MouseEvent): boolean {
	return event.kind === "press" && event.button === 0 && !event.motion && !event.shift;
}
