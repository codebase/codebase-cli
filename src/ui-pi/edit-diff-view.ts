import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { diffLines, diffWordsWithSpace } from "diff";
import { displayPath } from "../ui/paths.js";
import { highlightSegments, languageForPath, type Segment } from "./syntax.js";
import { ansi } from "./theme.js";

export const FILE_EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

type RowKind = "context" | "add" | "remove" | "gap";

interface Row {
	kind: RowKind;
	num?: number;
	/** Plain line text, tabs expanded. */
	text: string;
	/** [start, end) spans of `text` that changed within a paired line. */
	marks?: [number, number][];
	/** Syntax segments taken from a whole-file highlight, when the file was available. */
	segments?: Segment[];
	/** `text` with syntax colors and change marks applied. */
	styled?: string;
}

interface EditPreview {
	verb: string;
	summary: string;
	rows: Row[];
	hidden: number;
}

const CONTEXT_LINES = 3;
const WRITE_PREVIEW_ROWS = 10;
const EDIT_PREVIEW_ROWS = 40;
const MAX_READ_BYTES = 2 * 1024 * 1024;
// Whole-file highlighting gives edits the same colors as writes; skip it on huge files.
const MAX_HIGHLIGHT_BYTES = 256 * 1024;
const CACHE_LIMIT = 200;

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const FG_OFF = `${ESC}39;23m`;
const BG = { add: `${ESC}48;2;2;40;0m`, remove: `${ESC}48;2;61;1;0m` };
const HL = { add: `${ESC}48;2;4;71;0m`, remove: `${ESC}48;2;92;2;0m` };
const GUTTER = { add: `${ESC}38;2;79;199;79m`, remove: `${ESC}38;2;220;90;90m` };

// Keyed by tool-call id: rows are computed from the file as it stood when
// the call settled, so later edits to the same file don't shift old previews.
const cache = new Map<string, EditPreview | null>();

/** Header + summary + numbered diff rows for a completed file-edit tool call. */
export function renderFileEdit(callId: string, name: string, args: unknown, width: number): string[] | null {
	let preview = cache.get(callId);
	if (preview === undefined) {
		preview = buildPreview(name, args);
		cache.set(callId, preview);
		if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
	}
	if (!preview) return null;

	const a = (args ?? {}) as Record<string, unknown>;
	const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
	const out = wrapTextWithAnsi(`${ansi.bold(preview.verb)}(${displayPath(rawPath)})`, Math.max(10, width - 2)).map(
		(l, i) => (i === 0 ? `${ansi.green("●")} ${l}` : `  ${l}`),
	);
	out.push(`${ansi.dim("  ⎿")}  ${preview.summary}`);

	const indent = "     ";
	const maxNum = preview.rows.reduce((m, r) => Math.max(m, r.num ?? 0), 0);
	const numW = maxNum > 0 ? String(maxNum).length : 0;
	const contentW = Math.max(10, width - indent.length - numW - 3);
	for (const row of preview.rows) {
		if (row.kind === "gap") {
			out.push(`${indent}${ansi.dim(`${" ".repeat(Math.max(0, numW - 1))}⋮`)}`);
			continue;
		}
		const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
		const num = row.num === undefined ? " ".repeat(numW) : String(row.num).padStart(numW);
		const pieces = wrapTextWithAnsi(row.styled ?? row.text, contentW);
		if (pieces.length === 0) pieces.push("");
		pieces.forEach((piece, i) => {
			const gutter = i === 0 ? `${num} ${sign} ` : " ".repeat(numW + 3);
			if (row.kind === "context") {
				out.push(`${indent}${ansi.dim(gutter)}${piece}${RESET}`);
				return;
			}
			const bg = BG[row.kind as "add" | "remove"];
			const pad = " ".repeat(Math.max(0, contentW - visibleWidth(piece)));
			out.push(`${indent}${bg}${GUTTER[row.kind as "add" | "remove"]}${gutter}${FG_OFF}${piece}${bg}${pad}${RESET}`);
		});
	}
	if (preview.hidden > 0) {
		out.push(`${indent}${ansi.dim(`… +${preview.hidden} line${preview.hidden === 1 ? "" : "s"}`)}`);
	}
	return out;
}

function buildPreview(name: string, args: unknown): EditPreview | null {
	const a = (args ?? {}) as Record<string, unknown>;
	const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";

	if (name === "write_file") {
		const content = typeof a.content === "string" ? a.content : "";
		const lines = splitLines(content);
		const rows = lines.map((text, i): Row => ({ kind: "add", num: i + 1, text: expandTabs(text) }));
		colorize(rows, languageForPath(rawPath));
		return {
			verb: "Write",
			summary: `Wrote ${ansi.bold(String(lines.length))} line${lines.length === 1 ? "" : "s"}`,
			...clip(rows, WRITE_PREVIEW_ROWS),
		};
	}

	const edits: { old: string; new: string }[] = [];
	if (name === "edit_file") {
		edits.push({ old: str(a.old_string), new: str(a.new_string) });
	} else if (name === "multi_edit" && Array.isArray(a.edits)) {
		for (const e of a.edits) {
			if (e && typeof e === "object") {
				const ed = e as Record<string, unknown>;
				edits.push({ old: str(ed.old_string), new: str(ed.new_string) });
			}
		}
	} else {
		return null;
	}
	if (edits.length === 0) return null;

	const file = readSmall(rawPath);
	const lang = languageForPath(rawPath);
	const highlight =
		lang && file !== undefined && file.length <= MAX_HIGHLIGHT_BYTES
			? (text: string) => highlightSegments(text, lang)
			: undefined;
	const rows: Row[] = [];
	let added = 0;
	let removed = 0;
	const newFile = highlight && file !== undefined ? lazy(() => highlight(file)) : undefined;
	for (const edit of edits) {
		const region = diffRegion(edit.old, edit.new, file, highlight && newFile && { highlight, newFile });
		if (rows.length > 0) rows.push({ kind: "gap", text: "" });
		rows.push(...region.rows);
		added += region.added;
		removed += region.removed;
	}
	if (added === 0 && removed === 0) return null;
	colorize(rows, lang);

	const parts: string[] = [];
	if (added > 0)
		parts.push(`${parts.length ? "added" : "Added"} ${ansi.bold(String(added))} line${added === 1 ? "" : "s"}`);
	if (removed > 0)
		parts.push(
			`${parts.length ? "removed" : "Removed"} ${ansi.bold(String(removed))} line${removed === 1 ? "" : "s"}`,
		);
	return { verb: "Update", summary: parts.join(", "), ...clip(rows, EDIT_PREVIEW_ROWS) };
}

/**
 * Diff one old→new replacement as whole lines. When the new text can be
 * found in the file we widen it to full lines, number it, and add a few
 * lines of surrounding context; otherwise the bare diff renders unnumbered.
 */
function diffRegion(
	oldStr: string,
	newStr: string,
	file: string | undefined,
	whole?: { highlight: (text: string) => Segment[][]; newFile: () => Segment[][] },
) {
	let oldText = oldStr;
	let newText = newStr;
	let startLine: number | undefined;
	let before: string[] = [];
	let after: string[] = [];
	let oldFile: string | undefined;

	const idx = file !== undefined && newStr ? file.indexOf(newStr) : -1;
	if (file !== undefined && idx >= 0) {
		const lineStart = file.lastIndexOf("\n", idx - 1) + 1;
		const endIdx = idx + newStr.length;
		const nl = file.indexOf("\n", endIdx);
		const lineEnd = newStr.endsWith("\n") ? endIdx : nl === -1 ? file.length : nl;
		const prefix = file.slice(lineStart, idx);
		const suffix = file.slice(endIdx, lineEnd);
		oldText = prefix + oldStr + suffix;
		newText = prefix + newStr + suffix;
		startLine = countNewlines(file, lineStart) + 1;
		oldFile = file.slice(0, lineStart) + oldText + file.slice(lineEnd);

		const fileLines = file.split("\n");
		const firstIdx = startLine - 1;
		before = fileLines.slice(Math.max(0, firstIdx - CONTEXT_LINES), firstIdx);
		const newLineCount = splitLines(newText).length;
		after = fileLines.slice(firstIdx + newLineCount, firstIdx + newLineCount + CONTEXT_LINES);
		if (
			after.length > 0 &&
			after[after.length - 1] === "" &&
			firstIdx + newLineCount + after.length >= fileLines.length
		)
			after.pop();
	}

	// diffLines treats "x" and "x\n" as different lines; end both sides alike.
	if (!oldText.endsWith("\n")) oldText += "\n";
	if (!newText.endsWith("\n")) newText += "\n";

	const rows: Row[] = [];
	let oldNum = startLine;
	let newNum = startLine;
	const bump = (n: number | undefined) => (n === undefined ? undefined : n + 1);

	if (startLine !== undefined) {
		before.forEach((text, i) => {
			rows.push({ kind: "context", num: startLine - before.length + i, text: expandTabs(text) });
		});
	}

	let added = 0;
	let removed = 0;
	const changes = diffLines(oldText, newText);
	for (let i = 0; i < changes.length; i++) {
		const c = changes[i];
		const lines = splitLines(c.value);
		const next = changes[i + 1];
		if (c.removed && next?.added) {
			const addLines = splitLines(next.value);
			const paired = lines.length === addLines.length;
			const removeRows: Row[] = [];
			const addRows: Row[] = [];
			lines.forEach((text, j) => {
				const words = paired ? diffWordsWithSpace(text, addLines[j]) : undefined;
				removeRows.push({
					kind: "remove",
					num: oldNum,
					text: expandTabs(text),
					marks: words ? changedSpans(words, "remove") : undefined,
				});
				oldNum = bump(oldNum);
			});
			addLines.forEach((text, j) => {
				const words = paired ? diffWordsWithSpace(lines[j], text) : undefined;
				addRows.push({
					kind: "add",
					num: newNum,
					text: expandTabs(text),
					marks: words ? changedSpans(words, "add") : undefined,
				});
				newNum = bump(newNum);
			});
			rows.push(...removeRows, ...addRows);
			removed += lines.length;
			added += addLines.length;
			i++;
			continue;
		}
		for (const text of lines) {
			if (c.added) {
				rows.push({ kind: "add", num: newNum, text: expandTabs(text) });
				newNum = bump(newNum);
				added++;
			} else if (c.removed) {
				rows.push({ kind: "remove", num: oldNum, text: expandTabs(text) });
				oldNum = bump(oldNum);
				removed++;
			} else {
				rows.push({ kind: "context", num: newNum, text: expandTabs(text) });
				oldNum = bump(oldNum);
				newNum = bump(newNum);
			}
		}
	}

	if (newNum !== undefined) {
		const afterStart = newNum;
		after.forEach((text, i) => {
			rows.push({ kind: "context", num: afterStart + i, text: expandTabs(text) });
		});
	}

	// Color rows from the whole file (old file for removed lines) so code
	// embedded in another language — CSS in <style>, JS in <script> — gets
	// the same colors a write of that file shows.
	if (whole && oldFile !== undefined) {
		const old = oldFile;
		const oldFileLines = lazy(() => whole.highlight(old));
		for (const row of rows) {
			if (row.num === undefined) continue;
			const source = row.kind === "remove" ? oldFileLines() : whole.newFile();
			const segments = source[row.num - 1]?.map((seg) => ({ ...seg, text: expandTabs(seg.text) }));
			if (segments && segments.map((seg) => seg.text).join("") === row.text) row.segments = segments;
		}
	}
	return { rows, added, removed };
}

function changedSpans(
	parts: { value: string; added?: boolean; removed?: boolean }[],
	kind: "add" | "remove",
): [number, number][] {
	const skip = kind === "add" ? "removed" : "added";
	const mark = kind === "add" ? "added" : "removed";
	const spans: [number, number][] = [];
	let at = 0;
	for (const p of parts) {
		if (p[skip]) continue;
		const len = expandTabs(p.value).length;
		if (p[mark]) spans.push([at, at + len]);
		at += len;
	}
	return spans;
}

/**
 * Syntax-color every row. The new side (context + added) and the old side
 * (removed) are each highlighted as one block so multi-line comments and
 * strings keep their color across rows.
 */
function colorize(rows: Row[], lang: string | undefined): void {
	for (const row of rows) if (row.segments) row.styled = applyMarks(row.segments, row);
	for (const side of ["add", "remove"] as const) {
		const sideRows = rows.filter((r) => !r.segments && (r.kind === side || (side === "add" && r.kind === "context")));
		const segments = highlightSegments(sideRows.map((r) => r.text).join("\n"), lang);
		sideRows.forEach((row, i) => {
			row.styled = applyMarks(segments[i] ?? [{ text: row.text }], row);
		});
	}
}

/** Render segments as ANSI, switching to the brighter background inside changed spans. */
function applyMarks(segments: Segment[], row: Row): string {
	const kind = row.kind === "add" || row.kind === "remove" ? row.kind : undefined;
	const marks = row.marks ?? [];
	const inMark = (pos: number) => marks.some(([s, e]) => pos >= s && pos < e);
	let out = "";
	let at = 0;
	let marked = false;
	for (const seg of segments) {
		let chunk = "";
		for (const ch of seg.text) {
			const m = inMark(at);
			if (kind && m !== marked) {
				chunk += m ? HL[kind] : BG[kind];
				marked = m;
			}
			chunk += ch;
			at += ch.length;
		}
		out += seg.style ? `${ESC}${seg.style}m${chunk}${FG_OFF}` : chunk;
	}
	if (kind && marked) out += BG[kind];
	return out;
}

function lazy<T>(make: () => T): () => T {
	let value: { v: T } | undefined;
	return () => {
		value ??= { v: make() };
		return value.v;
	};
}

function clip(rows: Row[], max: number): { rows: Row[]; hidden: number } {
	if (rows.length <= max) return { rows, hidden: 0 };
	return { rows: rows.slice(0, max), hidden: rows.length - max };
}

function readSmall(rawPath: string): string | undefined {
	if (!rawPath) return undefined;
	try {
		const abs = resolve(process.cwd(), rawPath);
		if (statSync(abs).size > MAX_READ_BYTES) return undefined;
		return readFileSync(abs, "utf8");
	} catch {
		return undefined;
	}
}

function splitLines(s: string): string[] {
	if (!s) return [];
	return s.replace(/\n$/, "").split("\n");
}

function countNewlines(s: string, end: number): number {
	let n = 0;
	for (let i = 0; i < end; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

function expandTabs(s: string): string {
	return s.replace(/\t/g, "    ").replace(/\r$/, "");
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}
