import { diffLines, diffWordsWithSpace } from "diff";
import { Box, Text } from "ink";
import { truncate } from "./tool-labels.js";

/** One word-level span inside a paired remove/add line. */
export interface WordPart {
	text: string;
	/** True when this span is the *changed* part (renders with a brighter background). */
	highlight: boolean;
}

export interface DiffHunk {
	type: "remove" | "add";
	text: string;
	/** Present when this line was paired with a counterpart line — enables word-level highlight. */
	wordParts?: WordPart[];
}

export interface DiffInfo {
	added: number;
	removed: number;
	hunks: DiffHunk[];
	/** True when the change set exceeded MAX_HUNK_LINES and we clipped the preview. */
	truncated: boolean;
}

/** How many change lines we'll render before collapsing to just the +/- counts. */
const MAX_HUNK_LINES = 12;

/**
 * Build a diff summary for a completed file-edit tool call from the
 * tool's args. We have old_string + new_string right there, so no
 * filesystem round-trip needed. Uses the `diff` library's LCS-based
 * line pairing — adding a single line at the top no longer marks the
 * whole rest of the file as "changed."
 */
export function diffSummary(name: string, args: unknown): DiffInfo | null {
	const a = (args ?? {}) as Record<string, unknown>;
	if (name === "edit_file") {
		const oldStr = typeof a.old_string === "string" ? a.old_string : "";
		const newStr = typeof a.new_string === "string" ? a.new_string : "";
		if (!oldStr && !newStr) return null;
		return buildDiff(oldStr, newStr);
	}
	if (name === "multi_edit") {
		const edits = Array.isArray(a.edits) ? a.edits : [];
		let added = 0;
		let removed = 0;
		const hunks: DiffHunk[] = [];
		let truncated = false;
		for (const e of edits) {
			if (!e || typeof e !== "object") continue;
			const ed = e as Record<string, unknown>;
			const oldStr = typeof ed.old_string === "string" ? ed.old_string : "";
			const newStr = typeof ed.new_string === "string" ? ed.new_string : "";
			const sub = buildDiff(oldStr, newStr);
			added += sub.added;
			removed += sub.removed;
			truncated = truncated || sub.truncated;
			hunks.push(...sub.hunks);
		}
		if (added === 0 && removed === 0) return null;
		return {
			added,
			removed,
			hunks: hunks.slice(0, MAX_HUNK_LINES),
			truncated: truncated || hunks.length > MAX_HUNK_LINES,
		};
	}
	if (name === "write_file") {
		const content = typeof a.content === "string" ? a.content : "";
		if (!content) return null;
		const lines = content.split("\n").length;
		return { added: lines, removed: 0, hunks: [], truncated: false };
	}
	return null;
}

/**
 * LCS-based line diff, then pair adjacent remove+add changes so we can
 * surface a word-level highlight on each paired line. When a pair has
 * the same number of lines on each side, we line-align them and run
 * diffWordsWithSpace per row — that's the cleanest case and matches
 * the user expectation of "show me what actually changed in this row."
 */
function buildDiff(oldStr: string, newStr: string): DiffInfo {
	const changes = diffLines(oldStr, newStr);
	const hunks: DiffHunk[] = [];
	let added = 0;
	let removed = 0;
	const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);

	for (let i = 0; i < changes.length; i++) {
		const c = changes[i];
		if (c.added) added += lineCount(c.value);
		if (c.removed) removed += lineCount(c.value);

		const next = changes[i + 1];
		const isPair = c.removed && next?.added;
		if (isPair) {
			const removeLines = c.value.replace(/\n$/, "").split("\n");
			const addLines = next.value.replace(/\n$/, "").split("\n");
			if (removeLines.length === addLines.length) {
				// Paired row-by-row → word-level diff per row.
				for (let j = 0; j < removeLines.length; j++) {
					const parts = diffWordsWithSpace(removeLines[j], addLines[j]);
					hunks.push({
						type: "remove",
						text: removeLines[j],
						wordParts: parts.filter((p) => !p.added).map((p) => ({ text: p.value, highlight: !!p.removed })),
					});
					hunks.push({
						type: "add",
						text: addLines[j],
						wordParts: parts.filter((p) => !p.removed).map((p) => ({ text: p.value, highlight: !!p.added })),
					});
				}
			} else {
				// Asymmetric pair — show all removes then all adds without word diff.
				for (const line of removeLines) hunks.push({ type: "remove", text: line });
				for (const line of addLines) hunks.push({ type: "add", text: line });
			}
			i++; // Consume the paired add change.
			continue;
		}

		if (c.removed || c.added) {
			const type: DiffHunk["type"] = c.added ? "add" : "remove";
			for (const line of c.value.replace(/\n$/, "").split("\n")) {
				hunks.push({ type, text: line });
			}
		}
		// Context (neither added nor removed) is dropped — the +N/-M
		// counts plus the change lines themselves give enough orientation
		// for the small previews we render.
	}

	const truncated = hunks.length > MAX_HUNK_LINES;
	return { added, removed, hunks: hunks.slice(0, MAX_HUNK_LINES), truncated };
}

/**
 * Render the +N -M summary line, then up to MAX_HUNK_LINES change lines.
 * Removed lines render in red, added lines in green. Within a paired
 * remove/add row, the actually-changed words get a brighter background
 * so the eye lands on the substantive change immediately.
 */
export function DiffSummary({ diff, width, keyPrefix }: { diff: DiffInfo; width: number; keyPrefix: string }) {
	const counts = diff.truncated
		? `    +${diff.added} -${diff.removed} (preview truncated)`
		: `    +${diff.added} -${diff.removed}`;
	const lineWidth = Math.max(20, width - 8);
	return (
		<Box flexDirection="column" marginLeft={2}>
			<Text dimColor>{counts}</Text>
			{/* biome-ignore lint/suspicious/noArrayIndexKey: hunks are freshly built per render from
			    immutable args; no reorder, no insertion, so index is a stable per-render key */}
			{diff.hunks.map((h, i) => {
				const isRemove = h.type === "remove";
				const sign = isRemove ? "    - " : "    + ";
				const lineColor = isRemove ? "red" : "green";
				const hlBg = isRemove ? "redBright" : "greenBright";
				const key = `${keyPrefix}-h-${i}-${h.type}-${h.text.slice(0, 24)}`;
				if (h.wordParts && h.wordParts.length > 0) {
					// Truncate at the part boundary that crosses the width budget.
					let used = 0;
					const visibleParts: WordPart[] = [];
					for (const p of h.wordParts) {
						const remaining = lineWidth - used;
						if (remaining <= 0) break;
						if (p.text.length <= remaining) {
							visibleParts.push(p);
							used += p.text.length;
						} else {
							visibleParts.push({ ...p, text: `${p.text.slice(0, Math.max(0, remaining - 1))}…` });
							break;
						}
					}
					// Stable keys per-word: counter-suffix is only for collision when
					// the same word appears multiple times in a line. Avoids the
					// array-index-as-key smell while keeping React's reconciler happy.
					const seenCounts = new Map<string, number>();
					const keyedParts = visibleParts.map((p) => {
						const baseKey = `${p.highlight ? "h" : "n"}:${p.text}`;
						const count = seenCounts.get(baseKey) ?? 0;
						seenCounts.set(baseKey, count + 1);
						return { part: p, k: `${key}-w-${baseKey}-${count}` };
					});
					return (
						<Box key={key}>
							<Text color={lineColor}>{sign}</Text>
							<Text>
								{keyedParts.map(({ part, k }) => (
									<Text key={k} color={lineColor} backgroundColor={part.highlight ? hlBg : undefined}>
										{part.text}
									</Text>
								))}
							</Text>
						</Box>
					);
				}
				return (
					<Text key={key} color={lineColor}>
						{sign}
						{truncate(h.text, lineWidth)}
					</Text>
				);
			})}
		</Box>
	);
}
