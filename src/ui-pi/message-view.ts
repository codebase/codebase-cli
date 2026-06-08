import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolExecution } from "../types.js";
import { type DiffHunk, type DiffInfo, diffSummary } from "../ui/diff-summary.js";
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
import { ansi, markdownTheme } from "./theme.js";

const wrap = (text: string, width: number) => wrapTextWithAnsi(text, width);

/**
 * Single transcript row with a colored "│ " gutter on every line, role-
 * colored bold label header, then content blocks underneath. Mirrors
 * ink-era Message.tsx — the vertical accent gutter is the strongest
 * visual signal in the chat surface, so the pi-tui path needs it too.
 *
 * Content blocks are stored as pi-tui Components; the gutter is added
 * here at render time by wrapping every child line with the accent
 * prefix. This means Markdown / Text / ToolCallLine all keep their
 * normal line output and we don't have to know their internals.
 */
export class MessageView implements Component {
	private readonly accent: (text: string) => string;
	private readonly label: string;
	private readonly streaming: boolean;
	private blocks: Component[];

	constructor(opts: { accent: (s: string) => string; label: string; streaming: boolean; blocks: Component[] }) {
		this.accent = opts.accent;
		this.label = opts.label;
		this.streaming = opts.streaming;
		this.blocks = opts.blocks;
	}

	setBlocks(blocks: Component[]): void {
		this.blocks = blocks;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const gutter = this.accent("│ ");
		const out: string[] = [];
		out.push(`${gutter}${this.accent(ansi.bold(this.label))}${this.streaming ? ansi.dim(" …") : ""}`);
		for (const block of this.blocks) {
			const childLines = block.render(innerWidth);
			for (const line of childLines) out.push(`${gutter}${line}`);
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
 * loop. When complete, also emits an indented diff summary for
 * edit_file / multi_edit / write_file calls — the user gets to see what
 * the agent actually changed without spending a tool turn to diff.
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
		const status = exec?.status ?? "done";

		if (status === "running") {
			const frame = SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length];
			const label = toolActionLabel(this.name, this.args);
			return wrap(`${frame} ${label}…`, width).map((l) => ansi.magenta(l));
		}

		const isError = status === "error";
		const glyph = isError ? "✗" : "✓";
		const color = isError ? ansi.red : ansi.magenta;
		const past = toolActionPast(this.name, this.args);
		const lines = wrap(`${glyph} ${past}`, width).map((l) => color(l));

		// Diff summary for edits — indented under the tool-call line so
		// the read flows top-to-bottom: "what just happened" then "what
		// changed." Skipped on errors since the tool didn't apply.
		if (!isError) {
			const diff = diffSummary(this.name, this.args);
			if (diff) {
				for (const dl of renderDiff(diff, Math.max(20, width - 2))) lines.push(dl);
			}
		}
		return lines;
	}

	invalidate(): void {}
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
			? SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length]
			: anyError
				? "✗"
				: "✓";
		const color = anyError ? ansi.red : ansi.magenta;
		const verb = anyRunning ? presentVerbForReadTool(this.toolName) : pastVerbForReadTool(this.toolName);
		const noun = nounForReadTool(this.toolName, this.calls.length);
		const header = anyRunning
			? `${glyph} ${verb} ${doneCount} of ${this.calls.length} ${noun}…`
			: `${glyph} ${verb} ${this.calls.length} ${noun}`;

		const lines = wrap(header, width).map((l) => color(l));
		const pathWidth = Math.max(20, width - 6);
		for (const c of this.calls) {
			const a = (c.args ?? {}) as Record<string, unknown>;
			const rawPath =
				typeof a.path === "string"
					? a.path
					: typeof a.file_path === "string"
						? a.file_path
						: "";
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
 * Render a DiffInfo block as ANSI-colored lines. Word-level highlighting
 * mirrors the ink path: changed spans get a brighter background so the
 * reader's eye lands on the diff, not the unchanged context.
 */
function renderDiff(diff: DiffInfo, width: number): string[] {
	const out: string[] = [];
	const counts = diff.truncated
		? `    +${diff.added} -${diff.removed} (preview truncated)`
		: `    +${diff.added} -${diff.removed}`;
	out.push(ansi.dim(counts));
	const lineWidth = Math.max(20, width - 8);
	for (const h of diff.hunks) {
		out.push(renderHunk(h, lineWidth));
	}
	return out;
}

function renderHunk(h: DiffHunk, lineWidth: number): string {
	const isRemove = h.type === "remove";
	const sign = isRemove ? "    - " : "    + ";
	const color = isRemove ? ansi.red : ansi.green;
	if (h.wordParts && h.wordParts.length > 0) {
		// Word-level highlight: walk the parts, render plain spans with
		// the line color and highlighted spans with inverse video on top.
		const hl = isRemove ? bgRed : bgGreen;
		let used = 0;
		const pieces: string[] = [];
		for (const p of h.wordParts) {
			const remaining = lineWidth - used;
			if (remaining <= 0) break;
			let text = p.text;
			if (text.length > remaining) text = `${text.slice(0, Math.max(0, remaining - 1))}…`;
			pieces.push(p.highlight ? hl(color(text)) : color(text));
			used += text.length;
			if (text.endsWith("…")) break;
		}
		return `${color(sign)}${pieces.join("")}`;
	}
	return `${color(sign)}${color(truncate(h.text, lineWidth))}`;
}

const bgRed = (text: string): string => `\x1b[41m${text}\x1b[49m`;
const bgGreen = (text: string): string => `\x1b[42m${text}\x1b[49m`;

/**
 * Build the per-message child components from an AgentMessage's content.
 * Pulled out so the streaming-message swap and the final-message append
 * both produce structurally identical output.
 */
export function buildMessageBlocks(
	message: AgentMessage,
	tools: ReadonlyMap<string, ToolExecution>,
	role: string,
): Component[] {
	const out: Component[] = [];
	if (typeof message.content === "string") {
		if (message.content) out.push(new PlainText(message.content));
		return out;
	}
	if (!Array.isArray(message.content)) return out;
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
				if (role === "assistant") {
					out.push(new Markdown(block.text, 0, 0, markdownTheme));
				} else {
					out.push(new PlainText(block.text));
				}
				break;
			}
			case "thinking": {
				if (typeof block.thinking !== "string") break;
				out.push(new PlainText(ansi.dim(ansi.italic(block.thinking))));
				break;
			}
			case "toolCall": {
				if (typeof block.name !== "string" || typeof block.id !== "string") break;
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
