/**
 * Click-to-copy plumbing for the pi-tui transcript.
 *
 * pi-tui exposes no component→screen-row map, and it renders on the normal
 * screen (content scrolls into terminal scrollback), so we locate copy
 * boxes ourselves with an invisible position channel:
 *
 *   1. Each CopyBox prefixes every one of its rendered lines with a
 *      SENTINEL encoding its numeric id, built from Unicode Tag
 *      characters (U+E0020–U+E007F). Those are Default_Ignorable, which
 *      pi-tui's width calc treats as zero-width — so the sentinel never
 *      shifts layout.
 *   2. App.render() calls super.render() to get the whole composed column,
 *      scans each line for a sentinel (recording id → line index), strips
 *      every sentinel, and returns the clean lines. The terminal never
 *      sees a sentinel.
 *   3. On a click, we map the viewport row to a logical line (the column
 *      is bottom-pinned during active use) and look up which id owns it.
 *
 * The CopyRegistry holds id → clean copyable text, written when a box is
 * created and read when a click lands.
 */

const TAG_BASE = 0xe0000;
const SENT_OPEN = String.fromCodePoint(TAG_BASE + 0x7b); // tag '{'
const SENT_CLOSE = String.fromCodePoint(TAG_BASE + 0x7d); // tag '}'
const SENTINEL_RE = /\u{E007B}([\u{E0030}-\u{E0039}]+)\u{E007D}/u;
const SENTINEL_RE_G = /\u{E007B}[\u{E0030}-\u{E0039}]+\u{E007D}/gu;

/** Build the zero-width sentinel that marks a line as belonging to box `id`. */
export function encodeSentinel(id: number): string {
	let digits = "";
	for (const ch of String(id)) digits += String.fromCodePoint(TAG_BASE + ch.charCodeAt(0));
	return `${SENT_OPEN}${digits}${SENT_CLOSE}`;
}

/** Decode the id from a single line, or null if it carries no sentinel. */
export function decodeSentinel(line: string): number | null {
	const m = SENTINEL_RE.exec(line);
	if (!m) return null;
	let ascii = "";
	for (const ch of m[1]) ascii += String.fromCharCode((ch.codePointAt(0) as number) - TAG_BASE);
	const id = Number.parseInt(ascii, 10);
	return Number.isFinite(id) ? id : null;
}

export interface ScanResult {
	/** Lines with all sentinels stripped — safe to hand to the terminal. */
	clean: string[];
	/** Logical line index → box id, for every line that carried a sentinel. */
	lineToId: Map<number, number>;
}

/** Record each line's owning box id, then strip sentinels from every line. */
export function scanAndStrip(lines: readonly string[]): ScanResult {
	const lineToId = new Map<number, number>();
	const clean: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const id = decodeSentinel(lines[i]);
		if (id !== null) lineToId.set(i, id);
		clean.push(lines[i].includes(SENT_OPEN) ? lines[i].replace(SENTINEL_RE_G, "") : lines[i]);
	}
	return { clean, lineToId };
}

/**
 * Map a 1-based viewport row to a 0-based logical line in the rendered
 * column. During active use the column is pinned to the bottom of the
 * viewport: the last `height` logical lines are visible. When the whole
 * column fits on screen, it's top-anchored.
 */
export function viewportRowToLogical(row: number, totalLines: number, height: number): number {
	const firstVisible = Math.max(0, totalLines - height);
	return firstVisible + (row - 1);
}

/** Resolve a click at viewport `row` to the box id under it, or null. */
export function hitTest(
	lineToId: ReadonlyMap<number, number>,
	row: number,
	totalLines: number,
	height: number,
): number | null {
	const logical = viewportRowToLogical(row, totalLines, height);
	return lineToId.get(logical) ?? null;
}

/** Holds the clean copyable text for each live copy box, keyed by id. */
export class CopyRegistry {
	private readonly texts = new Map<number, string>();
	private nextId = 1;

	/** Reserve a stable id for a box keyed by a caller-supplied dedupe key. */
	private readonly keyToId = new Map<string, number>();

	idFor(key: string): number {
		const existing = this.keyToId.get(key);
		if (existing !== undefined) return existing;
		const id = this.nextId++;
		this.keyToId.set(key, id);
		return id;
	}

	set(id: number, text: string): void {
		this.texts.set(id, text);
	}

	get(id: number): string | undefined {
		return this.texts.get(id);
	}
}
