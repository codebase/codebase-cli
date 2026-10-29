import { visibleWidth } from "@earendil-works/pi-tui";

interface Point {
	row: number;
	col: number;
}

const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";
const ESCAPE = /^(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Click-and-drag text selection over the conversation view. The app owns
 * the mouse (for wheel scrolling), so the terminal's own selection is off;
 * this paints the selection in inverse video and hands back the plain text
 * on release for the clipboard.
 */
export class MouseSelection {
	private anchor: Point | undefined;
	private head: Point | undefined;
	private dragging = false;

	get active(): boolean {
		return this.anchor !== undefined && this.head !== undefined;
	}

	press(row: number, col: number): void {
		this.anchor = { row, col };
		this.head = undefined;
		this.dragging = true;
	}

	drag(row: number, col: number): void {
		if (!this.dragging || !this.anchor) return;
		this.head = { row, col };
	}

	/** End the drag; returns the selected text, or undefined for a plain click. */
	release(lines: readonly string[]): string | undefined {
		this.dragging = false;
		if (!this.anchor || !this.head) {
			this.clear();
			return undefined;
		}
		const text = this.text(lines);
		return text.trim() ? text : undefined;
	}

	clear(): void {
		this.anchor = undefined;
		this.head = undefined;
		this.dragging = false;
	}

	/** Selected text from the rendered rows, ANSI stripped, trailing spaces trimmed per row. */
	text(lines: readonly string[]): string {
		const out: string[] = [];
		this.forEachRow(lines.length, (row, from, to) => {
			out.push(sliceColumns(stripAnsi(lines[row] ?? ""), from, to).trimEnd());
		});
		return out.join("\n");
	}

	/** Paint the selection over rendered rows (inverse video, colors kept outside it). */
	paint(lines: string[]): string[] {
		if (!this.active) return lines;
		const out = [...lines];
		this.forEachRow(lines.length, (row, from, to) => {
			const line = lines[row] ?? "";
			const plain = stripAnsi(line);
			const end = Math.min(to, visibleWidth(plain));
			if (end <= from) return;
			out[row] =
				`${ansiColumns(line, 0, from)}${RESET}${INVERSE}${sliceColumns(plain, from, end)}${RESET}` +
				ansiColumns(line, end, Number.POSITIVE_INFINITY);
		});
		return out;
	}

	private forEachRow(rowCount: number, visit: (row: number, from: number, to: number) => void): void {
		if (!this.anchor || !this.head) return;
		const [start, end] = order(this.anchor, this.head);
		for (let row = Math.max(0, start.row); row <= Math.min(end.row, rowCount - 1); row++) {
			const from = row === start.row ? start.col : 0;
			const to = row === end.row ? end.col + 1 : Number.POSITIVE_INFINITY;
			visit(row, from, to);
		}
	}
}

function order(a: Point, b: Point): [Point, Point] {
	return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

export function stripAnsi(line: string): string {
	let out = "";
	for (let i = 0; i < line.length; ) {
		const esc = line[i] === "\x1b" ? ESCAPE.exec(line.slice(i)) : null;
		if (esc) {
			i += esc[0].length;
			continue;
		}
		out += line[i];
		i++;
	}
	return out;
}

/** Columns [from, to) of a plain string, by display width. */
export function sliceColumns(plain: string, from: number, to: number): string {
	let col = 0;
	let out = "";
	for (const ch of plain) {
		const w = visibleWidth(ch);
		if (col >= to) break;
		if (col >= from) out += ch;
		col += w;
	}
	return out;
}

/** Columns [from, to) of an ANSI string, replaying the styles in effect at `from`. */
function ansiColumns(line: string, from: number, to: number): string {
	let col = 0;
	let styles = "";
	let out = "";
	for (let i = 0; i < line.length; ) {
		const esc = line[i] === "\x1b" ? ESCAPE.exec(line.slice(i)) : null;
		if (esc) {
			const seq = esc[0];
			// Keep SGR state; drop hyperlinks so a cut can't leave one open.
			if (seq.endsWith("m")) {
				if (col < from) styles += seq;
				else if (col < to) out += seq;
			}
			i += seq.length;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i) ?? 0);
		if (col >= to) break;
		if (col >= from) out += ch;
		col += visibleWidth(ch);
		i += ch.length;
	}
	return out ? styles + out : "";
}
