import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripRuntimeMarkup } from "../agent/visible-messages.js";
import type { ReadFileDetails } from "../tools/read-file.js";
import type { ToolExecution } from "../types.js";
import { splitMarkdownSegments } from "../ui/markdown-split.js";
import { truncateOutput } from "../ui/output-truncate.js";
import { displayPath } from "../ui/paths.js";
import {
	COLLAPSIBLE_READ_TOOLS,
	nounForReadTool,
	pastVerbForReadTool,
	presentVerbForReadTool,
	toolActionLabel,
	toolActionPast,
	truncate,
} from "../ui/tool-labels.js";
import { CopyBox } from "./copy-box.js";
import type { CopyRegistry } from "./copy-targets.js";
import { FILE_EDIT_TOOLS, renderFileEdit } from "./edit-diff-view.js";
import { detectLanguage } from "./syntax.js";
import { ansi, markdownTheme } from "./theme.js";

const wrap = (text: string, width: number) => wrapTextWithAnsi(text, width);

export type MessageKind = "user" | "assistant" | "tool" | "system";

/**
 * A transcript turn. The speaker is conveyed by *treatment*, not a text
 * label: the user's words sit behind a solid accent bar (a quoted "card"),
 * everything the agent produces — prose, tool calls, results — flows as
 * open, indented text. No "you:" / "codebase:" headers, so consecutive
 * agent turns read as one continuous voice instead of a stutter of labels.
 *
 * Every block keeps its own line output; we only prepend the per-line
 * prefix here, so Markdown / Text / ToolCallLine stay oblivious.
 */
export class MessageView implements Component {
	private readonly kind: MessageKind;
	private blocks: Component[];

	constructor(opts: { kind: MessageKind; streaming?: boolean; blocks: Component[] }) {
		this.kind = opts.kind;
		this.blocks = opts.blocks;
	}

	setBlocks(blocks: Component[]): void {
		this.blocks = blocks;
	}

	appendBlocks(blocks: Component[]): void {
		this.blocks = [...this.blocks, ...blocks];
	}

	render(width: number): string[] {
		// User turns get a bold accent bar; agent/tool/system turns get a
		// flat 2-col indent. Both consume 2 columns, so content reflows the same.
		const prefix = this.kind === "user" ? `${ansi.bold(ansi.cyan("▌"))} ` : "  ";
		const innerWidth = Math.max(20, width - 2);
		const out: string[] = [];
		for (const block of this.blocks) {
			for (const line of block.render(innerWidth)) out.push(`${prefix}${line}`);
		}
		out.push("");
		return out;
	}

	invalidate(): void {
		for (const b of this.blocks) b.invalidate();
	}
}

/**
 * Inline tool-call line. Reads its current status from the shared tools
 * Map every render so the spinner / glyph stay in sync with the agent
 * loop. Completed file edits render as a numbered diff block instead
 * (see edit-diff-view.ts) so the user sees what actually changed.
 */
const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

export class ToolCallLine implements Component {
	constructor(
		private readonly callId: string,
		private readonly name: string,
		private readonly args: unknown,
		private readonly tools: ReadonlyMap<string, ToolExecution>,
	) {}

	render(width: number): string[] {
		const exec = this.tools.get(this.callId);
		// No execution record yet: the call is still streaming or waiting to
		// run. Never treat it as done — a file preview built now would read
		// the file before the edit and stick with partial arguments.
		if (!exec) {
			return wrap(`· ${toolActionLabel(this.name, this.args)}`, width).map((l) => ansi.dim(l));
		}
		const status = exec.status;

		if (status === "running") {
			const frame = SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length];
			const label = toolActionLabel(this.name, this.args);
			return wrap(`${frame} ${label}…`, width).map((l) => ansi.cyan(l));
		}

		if (status === "done" && FILE_EDIT_TOOLS.has(this.name)) {
			const edit = renderFileEdit(this.callId, this.name, this.args, width);
			if (edit) return edit;
		}

		// Completed tools recede into dim narrative so the eye stays on the
		// agent's prose; only the status glyph keeps a touch of color.
		const isError = status === "error";
		const glyph = isError ? ansi.red("✗") : ansi.green("✓");
		const color = isError ? ansi.red : ansi.dim;
		const past = toolActionPast(this.name, this.args);
		const wrapped = wrap(past, Math.max(10, width - 2));
		return wrapped.map((l, idx) => (idx === 0 ? `${glyph} ${color(l)}` : `  ${color(l)}`));
	}

	invalidate(): void {}
}

/**
 * Record executions for tool calls in a loaded (resumed / rewound) transcript,
 * from their saved results, so completed calls render as done and calls that
 * never got a result stay pending.
 */
export function seedToolExecutions(tools: Map<string, ToolExecution>, messages: readonly AgentMessage[]): void {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments });
			}
		} else if (m.role === "toolResult" && !tools.has(m.toolCallId)) {
			const call = calls.get(m.toolCallId);
			tools.set(m.toolCallId, {
				id: m.toolCallId,
				name: call?.name ?? m.toolName,
				args: call?.args,
				status: m.isError ? "error" : "done",
				startedAt: m.timestamp,
				endedAt: m.timestamp,
			});
		}
	}
}

interface CollapsedCall {
	id: string;
	args: unknown;
}

/**
 * Collapsed row for a run of pure-read tool calls — "✓ Read 3 files"
 * with the per-file paths in a dim indented list beneath. Mirrors the
 * ink-era CollapsedReadGroup so the pi-tui transcript reads the same
 * way when the agent does N consecutive read_file calls.
 */
export class CollapsedReadGroup implements Component {
	constructor(
		private readonly toolName: string,
		private readonly calls: readonly CollapsedCall[],
		private readonly tools: ReadonlyMap<string, ToolExecution>,
	) {}

	render(width: number): string[] {
		const statuses = this.calls.map((c) => this.tools.get(c.id)?.status);
		const anyRunning = statuses.some((s) => s === "running");
		const anyError = statuses.some((s) => s === "error");
		const doneCount = statuses.filter((s) => s !== "running").length;

		const glyph = anyRunning
			? ansi.cyan(SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length])
			: anyError
				? ansi.red("✗")
				: ansi.green("✓");
		const color = anyError ? ansi.red : anyRunning ? ansi.cyan : ansi.dim;
		const verb = anyRunning ? presentVerbForReadTool(this.toolName) : pastVerbForReadTool(this.toolName);
		const noun = nounForReadTool(this.toolName, this.calls.length);
		const header = anyRunning
			? `${verb} ${doneCount} of ${this.calls.length} ${noun}…`
			: `${verb} ${this.calls.length} ${noun}`;

		const lines = wrap(header, Math.max(10, width - 2)).map((l, idx) =>
			idx === 0 ? `${glyph} ${color(l)}` : `  ${color(l)}`,
		);
		const pathWidth = Math.max(20, width - 6);
		for (const c of this.calls) {
			const a = (c.args ?? {}) as Record<string, unknown>;
			const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
			const path = displayPath(rawPath);
			const status = this.tools.get(c.id)?.status;
			const failed = status === "error";
			const running = status === "running";
			const marker = failed ? "  ✗ " : running ? "  → " : "  · ";
			const row = `${marker}${truncate(path, pathWidth)}`;
			if (failed) lines.push(ansi.red(row));
			else if (running) lines.push(ansi.magenta(row));
			else lines.push(ansi.dim(row));
		}
		return lines;
	}

	invalidate(): void {}
}

/**
 * Build the per-message child components from an AgentMessage's content.
 * Pulled out so the streaming-message swap and the final-message append
 * both produce structurally identical output.
 */
export interface CopyBoxOptions {
	/** When set (and not streaming), code blocks + present_copy become clickable CopyBoxes. */
	registry?: CopyRegistry;
	/** Stable per-message prefix so a box keeps its id across re-renders. */
	keyPrefix?: string;
	/** Don't build CopyBoxes mid-stream — content churns until the turn settles. */
	streaming?: boolean;
}

export function buildMessageBlocks(
	message: AgentMessage,
	tools: ReadonlyMap<string, ToolExecution>,
	role: string,
	copy: CopyBoxOptions = {},
): Component[] {
	const out: Component[] = [];
	const copyable = copy.registry !== undefined && !copy.streaming;
	if (typeof message.content === "string") {
		const text = role === "toolResult" ? message.content : stripRuntimeMarkup(message.content);
		if (text) out.push(new PlainText(text));
		return out;
	}
	if (!Array.isArray(message.content)) return out;
	// ToolResult messages: collapse long output into head + (N hidden) +
	// tail using the per-tool cap from output-truncate. Errors render
	// in full red since the user needs the whole failure to debug.
	if (role === "toolResult") {
		const m = message as { toolName?: string; isError?: boolean; details?: unknown; content: unknown[] };
		// present_copy already rendered its box from the assistant toolCall;
		// suppress the redundant ack row here.
		if (m.toolName === "present_copy") return out;
		// A successful read shows which lines were read, never the file itself.
		if (m.toolName === "read_file" && !m.isError) {
			out.push(new PlainText(ansi.dim(`⎿  ${formatReadSummary(m.details, message.content)}`)));
			return out;
		}
		const text = message.content
			.map((block) => {
				if (typeof block === "object" && block !== null) {
					const b = block as { type?: string; text?: string; mimeType?: string };
					if (b.type === "text" && typeof b.text === "string") return b.text;
					if (b.type === "image") return `[image:${b.mimeType ?? "?"}]`;
				}
				return "";
			})
			.join("");
		const view = truncateOutput(text, m.toolName, m.isError === true);
		const colorize = (s: string) => (m.isError ? ansi.red(s) : s);
		if (!view.truncated) {
			if (view.full) out.push(new PlainText(colorize(view.full)));
		} else {
			out.push(new PlainText(colorize(view.head)));
			out.push(new PlainText(ansi.dim(`… ${view.hidden} line${view.hidden === 1 ? "" : "s"} hidden …`)));
			out.push(new PlainText(colorize(view.tail)));
		}
		return out;
	}
	const blocks = message.content;
	let i = 0;
	while (i < blocks.length) {
		const block = blocks[i];
		// Collapse runs of consecutive read-only tool calls of the same
		// kind ("✓ Read 3 files"). Mirrors the ink path's CollapsedReadGroup;
		// the user gets one summary row instead of N near-identical lines.
		if (block.type === "toolCall" && COLLAPSIBLE_READ_TOOLS.has(block.name)) {
			let runEnd = i + 1;
			while (runEnd < blocks.length) {
				const next = blocks[runEnd];
				if (next.type !== "toolCall" || next.name !== block.name) break;
				runEnd++;
			}
			if (runEnd - i >= 2) {
				const calls: CollapsedCall[] = [];
				for (let j = i; j < runEnd; j++) {
					const b = blocks[j];
					if (b.type === "toolCall") calls.push({ id: b.id, args: b.arguments });
				}
				out.push(new CollapsedReadGroup(block.name, calls, tools));
				i = runEnd;
				continue;
			}
		}
		switch (block.type) {
			case "text": {
				if (typeof block.text !== "string") break;
				const visibleText = role === "toolResult" ? block.text : stripRuntimeMarkup(block.text);
				if (!visibleText) break;
				if (role !== "assistant") {
					out.push(new PlainText(visibleText));
					break;
				}
				// Split assistant prose from fenced code so each code block
				// becomes its own click-to-copy box; prose keeps markdown
				// rendering. During streaming, render the whole thing as
				// markdown to avoid box churn until the turn settles.
				if (copyable && copy.registry) {
					const segments = splitMarkdownSegments(visibleText);
					segments.forEach((seg, s) => {
						if (seg.type === "code" && seg.text.trim()) {
							out.push(
								new CopyBox(
									copy.registry as CopyRegistry,
									`${copy.keyPrefix}:b${i}:s${s}`,
									seg.lang || detectLanguage(seg.text) || "code",
									seg.text,
								),
							);
						} else {
							out.push(new Markdown(seg.text, 0, 0, markdownTheme));
						}
					});
				} else {
					out.push(new Markdown(visibleText, 0, 0, markdownTheme));
				}
				break;
			}
			case "thinking": {
				break;
			}
			case "toolCall": {
				if (typeof block.name !== "string" || typeof block.id !== "string") break;
				// present_copy renders as a click-to-copy box instead of a
				// tool-call line — the args carry the payload directly.
				if (block.name === "present_copy" && copyable && copy.registry) {
					const a = (block.arguments ?? {}) as { label?: string; content?: string };
					if (typeof a.content === "string" && a.content) {
						out.push(new CopyBox(copy.registry, `${copy.keyPrefix}:b${i}`, a.label || "copy", a.content));
						break;
					}
				}
				out.push(new ToolCallLine(block.id, block.name, block.arguments, tools));
				break;
			}
			case "image": {
				out.push(new PlainText(ansi.dim(formatImageCard(block))));
				break;
			}
			// Unknown content kinds (server gateways could add new ones; pi-ai's
			// union may grow). Skip silently rather than crash the render.
		}
		i++;
	}
	return out;
}

/** Results that render as a one-line summary under their tool call, without a blank line between. */
export function attachesToPrevious(message: AgentMessage): boolean {
	const m = message as { role: string; toolName?: string; isError?: boolean };
	return m.role === "toolResult" && m.toolName === "read_file" && !m.isError;
}

/** "50 lines · 20–69 of 75" for a read_file result, from its details (or, for older sessions, its numbered output). */
export function formatReadSummary(details: unknown, content: unknown[]): string {
	const d = (details ?? {}) as Partial<ReadFileDetails>;
	if (d.isImage) return "Read image";
	const text = content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("");
	const numbered = text.split("\n").filter((line) => /^\s*\d+→/.test(line));
	const count = d.returnedLines ?? numbered.length;
	if (count === 0) return "Empty file";
	const start = d.startLine || Number(/^\s*(\d+)→/.exec(numbered[0] ?? "")?.[1] ?? 1);
	const end = d.endLine || start + count - 1;
	const lines = `${count} line${count === 1 ? "" : "s"}`;
	const total = d.totalLines;
	if (total !== undefined && start === 1 && end >= total) return `${lines} · 1–${end} (whole file)`;
	return `${lines} · ${start}–${end}${total !== undefined ? ` of ${total}` : ""}`;
}

/**
 * Render a user image attachment as a single dim line — "📷 image (PNG, 142 KB)".
 * Base64 length × 3/4 is the byte estimate; close enough for a transcript label.
 * Matches the v2 React path's UserBlocks renderer so the two render the same.
 */
function formatImageCard(block: { mimeType?: string; data?: string }): string {
	const subtype = (block.mimeType ?? "image/?").split("/")[1]?.toUpperCase() ?? "?";
	const bytes = block.data ? Math.floor((block.data.length * 3) / 4) : 0;
	const size = bytes > 0 ? `, ${formatBytes(bytes)}` : "";
	return `📷 image (${subtype}${size})`;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Minimal wrapped-text Component without padding — Text adds 1col paddingX which fights the gutter. */
export class PlainText implements Component {
	constructor(private readonly text: string) {}
	render(width: number): string[] {
		if (!this.text) return [""];
		const out: string[] = [];
		for (const para of this.text.split("\n")) {
			if (para === "") {
				out.push("");
				continue;
			}
			for (const line of wrap(para, width)) out.push(line);
		}
		return out;
	}
	invalidate(): void {}
}

export function widthOf(s: string): number {
	return visibleWidth(s);
}
