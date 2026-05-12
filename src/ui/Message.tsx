import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { diffLines, diffWordsWithSpace } from "diff";
import { Box, Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import type { ToolExecution } from "../types.js";
import { Markdown } from "./Markdown.js";
import { displayPath } from "./paths.js";
import {
	nounForReadTool,
	pastVerbForReadTool,
	presentVerbForReadTool,
	toolActionLabel,
	toolActionPast,
	truncate,
} from "./tool-labels.js";
import { wrapText } from "./wrap.js";

interface MessageProps {
	message: AgentMessage;
	streaming?: boolean;
	/** Terminal columns available to the message body, post-padding. Defaults to 80. */
	width?: number;
	/**
	 * Per-tool-call status from the agent loop. Used to render tool-call
	 * blocks with a live spinner + present tense ("Reading X") while
	 * running, and a ✓/✗ + past tense ("Read X") once complete — the
	 * Claude Code pattern.
	 */
	tools?: ReadonlyMap<string, ToolExecution>;
}

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

function useSpinner(active: boolean, intervalMs = 90): string {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);
	return SPINNER_FRAMES[frame];
}

const ROLE_STYLE = {
	user: { accent: "yellow", label: "you" },
	assistant: { accent: "cyan", label: "codebase" },
	toolResult: { accent: "magenta", label: "tool" },
} as const;

/**
 * Per-tool name overrides for the toolResult header label. Default falls
 * back to the raw tool name (read_file, grep, shell, …) which is more
 * useful than a generic "tool". A few tools get friendlier presentation
 * labels because their raw name reads oddly in the gutter.
 */
const TOOL_RESULT_LABEL: Record<string, string> = {
	shell: "bash",
	dispatch_agent: "subagent",
};

export function Message({ message, streaming, width = 80, tools }: MessageProps) {
	const role = message.role;
	const style = ROLE_STYLE[role as keyof typeof ROLE_STYLE];
	if (!style) return null;

	// The body sits inside `Box flexDirection=row` with a 1-col accent + 1-col
	// gap, plus the parent App's paddingX of 1 each side. Reserve 4 cols so
	// the wrapped text never tries to occupy the accent gutter.
	const bodyWidth = Math.max(20, width - 4);
	// Tool results carry the originating tool name on the message itself
	// (set by pi-agent-core). Surface that instead of the generic "tool"
	// label so users can see at a glance which tool produced this output.
	const headerLabel =
		role === "toolResult" && "toolName" in message && typeof message.toolName === "string"
			? (TOOL_RESULT_LABEL[message.toolName] ?? message.toolName)
			: style.label;

	return (
		<Box flexDirection="row" marginY={0}>
			<Box marginRight={1}>
				<Text color={style.accent}>│</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				<Text color={style.accent} bold>
					{headerLabel}
					{streaming ? " …" : ""}
				</Text>
				<MessageBody message={message} width={bodyWidth} tools={tools} />
			</Box>
		</Box>
	);
}

function MessageBody({
	message,
	width,
	tools,
}: {
	message: AgentMessage;
	width: number;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return <WrappedLines text={message.content} width={width} keyPrefix="user" />;
		}
		return <UserBlocks blocks={message.content} width={width} />;
	}

	if (message.role === "assistant") {
		const rendered = renderAssistantBlocks(message.content, width, tools);
		return (
			<>
				{rendered}
				{message.errorMessage ? (
					<WrappedLines text={`! ${message.errorMessage}`} width={width} keyPrefix="err" color="red" />
				) : null}
			</>
		);
	}

	if (message.role === "toolResult") {
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`))
			.join("");
		const toolName = "toolName" in message && typeof message.toolName === "string" ? message.toolName : undefined;
		return (
			<TruncatedOutput
				text={text}
				width={width}
				keyPrefix="tool"
				color={message.isError ? "red" : undefined}
				toolName={toolName}
			/>
		);
	}

	return null;
}

/**
 * One tool-call row that morphs through three states:
 *   running  → spinner + present tense  ("⣾ Reading src/index.ts")
 *   done     → ✓ + past tense           ("✓ Read src/index.ts")
 *   error    → ✗ + past tense + red     ("✗ Read src/index.ts")
 *
 * State source: the per-session `tools` Map on ChatState. If no entry
 * exists for this id (e.g. an old session being replayed without
 * inflight tracking), we render the past-tense "done" form — safe
 * fallback that never strands the UI on a fake spinner.
 */
function ToolCallLine({
	id,
	name,
	args,
	width,
	keyPrefix,
	tools,
}: {
	id: string;
	name: string;
	args: unknown;
	width: number;
	keyPrefix: string;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	const exec = tools?.get(id);
	const status = exec?.status ?? "done";
	const isRunning = status === "running";
	const spinner = useSpinner(isRunning);

	if (isRunning) {
		return (
			<WrappedLines
				text={`${spinner} ${toolActionLabel(name, args)}…`}
				width={width}
				keyPrefix={keyPrefix}
				color="magenta"
			/>
		);
	}

	const isError = status === "error";
	const glyph = isError ? "✗" : "✓";
	const past = toolActionPast(name, args);
	const diff = !isError ? diffSummary(name, args) : null;
	return (
		<>
			<WrappedLines
				text={`${glyph} ${past}`}
				width={width}
				keyPrefix={keyPrefix}
				color={isError ? "red" : "magenta"}
			/>
			{diff ? <DiffSummary diff={diff} width={width} keyPrefix={`${keyPrefix}-diff`} /> : null}
		</>
	);
}

/**
 * Tool calls that are pure reads — runs of these collapse into a single
 * "Read N files" / "Searched 3 patterns" line, the Claude Code pattern.
 * Keep the set tight: anything that mutates state, runs shell, or has a
 * meaningful argument shape (grep query, fetch URL) reads weird when
 * collapsed and stays per-row.
 */
const COLLAPSIBLE_READ_TOOLS: ReadonlySet<string> = new Set(["read_file"]);

type AssistantContent = (AgentMessage & { role: "assistant" })["content"];

/**
 * Walk an assistant message's content blocks, collapsing runs of
 * consecutive `read_file` (and other safe read-only) tool calls into a
 * single summary row. A run only collapses when every call in it is
 * completed (done or errored) — if any is still running we render the
 * group expanded so the spinner stays visible on the active row.
 */
function renderAssistantBlocks(
	content: AssistantContent,
	width: number,
	tools?: ReadonlyMap<string, ToolExecution>,
): ReactNode[] {
	const out: ReactNode[] = [];
	let i = 0;
	while (i < content.length) {
		const block = content[i];
		const key = blockKey(block, i);
		if (block.type === "text") {
			out.push(<Markdown key={key} text={block.text} width={width} keyPrefix={key} />);
			i++;
			continue;
		}
		if (block.type === "thinking") {
			out.push(
				<WrappedLines
					key={key}
					text={`(thinking) ${block.thinking}`}
					width={width}
					keyPrefix={key}
					dimColor
					italic
				/>,
			);
			i++;
			continue;
		}
		if (block.type === "toolCall") {
			if (COLLAPSIBLE_READ_TOOLS.has(block.name)) {
				let runEnd = i + 1;
				while (runEnd < content.length) {
					const next = content[runEnd];
					if (next.type !== "toolCall" || next.name !== block.name) break;
					runEnd++;
				}
				const run = [];
				for (let j = i; j < runEnd; j++) {
					const b = content[j];
					if (b.type === "toolCall") run.push(b);
				}
				if (run.length >= 2) {
					out.push(
						<CollapsedReadGroup
							key={`run-${run[0].id}`}
							calls={run}
							width={width}
							keyPrefix={`run-${run[0].id}`}
							tools={tools}
						/>,
					);
					i = runEnd;
					continue;
				}
			}
			out.push(
				<ToolCallLine
					key={key}
					id={block.id}
					name={block.name}
					args={block.arguments}
					width={width}
					keyPrefix={key}
					tools={tools}
				/>,
			);
			i++;
			continue;
		}
		i++;
	}
	return out;
}

/**
 * Collapsed row for a run of pure-read tool calls. Renders as
 * "✓ Read N files" with the per-file paths in a dim indented list
 * beneath. If any call errored, the glyph flips to ✗ and the line
 * goes red — we still show the paths so the user can see what
 * failed.
 */
type AssistantToolCall = Extract<AssistantContent[number], { type: "toolCall" }>;

function CollapsedReadGroup({
	calls,
	width,
	keyPrefix,
	tools,
}: {
	calls: readonly AssistantToolCall[];
	width: number;
	keyPrefix: string;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	const statuses = calls.map((c) => tools?.get(c.id)?.status);
	const anyRunning = statuses.some((s) => s === "running");
	const anyError = statuses.some((s) => s === "error");
	const doneCount = statuses.filter((s) => s !== "running").length;
	const spinner = useSpinner(anyRunning);
	const glyph = anyRunning ? spinner : anyError ? "✗" : "✓";
	const color = anyError ? "red" : "magenta";
	const verb = anyRunning ? presentVerbForReadTool(calls[0].name) : pastVerbForReadTool(calls[0].name);
	const noun = nounForReadTool(calls[0].name, calls.length);
	const header = anyRunning
		? `${glyph} ${verb} ${doneCount} of ${calls.length} ${noun}…`
		: `${glyph} ${verb} ${calls.length} ${noun}`;
	return (
		<>
			<WrappedLines text={header} width={width} keyPrefix={keyPrefix} color={color} />
			<Box flexDirection="column" marginLeft={2}>
				{calls.map((c) => {
					const a = (c.arguments ?? {}) as Record<string, unknown>;
					const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
					const path = displayPath(rawPath);
					const status = tools?.get(c.id)?.status;
					const failed = status === "error";
					const running = status === "running";
					const marker = failed ? "  ✗ " : running ? "  → " : "  · ";
					return (
						<Text
							key={`${keyPrefix}-f-${c.id}`}
							color={failed ? "red" : running ? "magenta" : undefined}
							dimColor={!failed && !running}
						>
							{marker}
							{truncate(path, Math.max(20, width - 6))}
						</Text>
					);
				})}
			</Box>
		</>
	);
}

/** One word-level span inside a paired remove/add line. */
interface WordPart {
	text: string;
	/** True when this span is the *changed* part (renders with a brighter background). */
	highlight: boolean;
}

interface DiffHunk {
	type: "remove" | "add";
	text: string;
	/** Present when this line was paired with a counterpart line — enables word-level highlight. */
	wordParts?: WordPart[];
}

interface DiffInfo {
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
function diffSummary(name: string, args: unknown): DiffInfo | null {
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
function DiffSummary({ diff, width, keyPrefix }: { diff: DiffInfo; width: number; keyPrefix: string }) {
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

const DEFAULT_MAX_TOOL_OUTPUT_LINES = 12;

/**
 * Per-tool display caps. Search-style tools (grep, find, glob) produce
 * many matches, most of which the user doesn't need to read inline —
 * the model still sees the full result. Default is 12 lines.
 */
const TOOL_OUTPUT_LIMITS: Record<string, number> = {
	grep: 6,
	search_files: 6,
	glob: 8,
	find: 8,
	list_files: 10,
};

/**
 * Truncate tool output past the per-tool limit into "head + (N hidden)
 * + tail" — long shell or grep output otherwise dominates the
 * transcript and pushes context off-screen. The agent still gets the
 * full output; this is purely a display trim. Errors are NEVER
 * truncated since the user needs to see exactly what blew up.
 */
function TruncatedOutput({
	text,
	width,
	keyPrefix,
	color,
	toolName,
}: {
	text: string;
	width: number;
	keyPrefix: string;
	color?: string;
	toolName?: string;
}) {
	const max =
		toolName && TOOL_OUTPUT_LIMITS[toolName] !== undefined
			? TOOL_OUTPUT_LIMITS[toolName]
			: DEFAULT_MAX_TOOL_OUTPUT_LINES;
	// Reserve at least 1 head + 1 tail line so the user can see the
	// shape of the truncation; rest is head-weighted (where the
	// interesting content usually is).
	const tailLines = max >= 8 ? 3 : 2;
	const headLines = Math.max(1, max - tailLines - 1);
	const lines = text.split("\n");
	if (color === "red" || lines.length <= max) {
		return <WrappedLines text={text} width={width} keyPrefix={keyPrefix} color={color} />;
	}
	const head = lines.slice(0, headLines).join("\n");
	const tail = lines.slice(lines.length - tailLines).join("\n");
	const hidden = lines.length - headLines - tailLines;
	return (
		<>
			<WrappedLines text={head} width={width} keyPrefix={`${keyPrefix}-h`} color={color} />
			<Text dimColor>{`… ${hidden} line${hidden === 1 ? "" : "s"} hidden …`}</Text>
			<WrappedLines text={tail} width={width} keyPrefix={`${keyPrefix}-t`} color={color} />
		</>
	);
}

interface WrappedLinesProps {
	text: string;
	width: number;
	keyPrefix: string;
	color?: string;
	dimColor?: boolean;
	italic?: boolean;
}

/**
 * Render text as N <Text> elements, one per pre-wrapped line. Stacks
 * vertically inside the parent column-flex Box. Pre-wrap means the
 * wraps happen at word boundaries, so when the user select-and-copies
 * they get clean line endings — no mid-word breaks at column edges.
 */
function WrappedLines({ text, width, keyPrefix, color, dimColor, italic }: WrappedLinesProps) {
	const lines = wrapText(text, width);
	return (
		<>
			{lines.map((line, i) => (
				// Wrapped lines have no per-line state — <Text> is pure-presentational —
				// so reusing instances on re-wrap is harmless; index-as-key is fine here.
				// biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf, reuse is safe
				<Text key={`${keyPrefix}:${i}`} color={color} dimColor={dimColor} italic={italic}>
					{line.length === 0 ? " " : line}
				</Text>
			))}
		</>
	);
}

/**
 * Render an array-content user message — typically text + one or more
 * image attachments. Text blocks pass through `WrappedLines`; image
 * blocks render as a dim "image (PNG, 142 KB)" line so the user can
 * see at a glance that an image was sent.
 */
function UserBlocks({ blocks, width }: { blocks: unknown; width: number }) {
	if (!Array.isArray(blocks)) return null;
	const rows: ReactNode[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i] as { type: string; text?: string; mimeType?: string; data?: string };
		if (b.type === "text" && b.text) {
			rows.push(<WrappedLines key={`u-t-${i}`} text={b.text} width={width} keyPrefix={`u-t-${i}`} />);
			continue;
		}
		if (b.type === "image") {
			const subtype = (b.mimeType ?? "image/?").split("/")[1]?.toUpperCase() ?? "?";
			const size = b.data ? formatBytes(Math.floor((b.data.length * 3) / 4)) : "";
			rows.push(
				<Text key={`u-i-${i}`} dimColor>
					📷 image ({subtype}
					{size ? `, ${size}` : ""})
				</Text>,
			);
		}
	}
	return <>{rows}</>;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Stable key per assistant content block. Tool calls have an id; text and
 * thinking blocks don't reorder within a message so position-in-type is fine.
 */
function blockKey(block: { type: string; id?: string }, idx: number): string {
	if (block.type === "toolCall" && block.id) return `tc-${block.id}`;
	return `${block.type}-${idx}`;
}
