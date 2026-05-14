import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Markdown, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ToolExecution } from "../types.js";
import { type DiffHunk, type DiffInfo, diffSummary } from "../ui/diff-summary.js";
import { toolActionLabel, toolActionPast, truncate } from "../ui/tool-labels.js";
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
	for (const block of message.content) {
		const b = block as {
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: unknown;
			id?: string;
		};
		if (b.type === "text" && typeof b.text === "string") {
			if (role === "assistant") {
				out.push(new Markdown(b.text, 0, 0, markdownTheme));
			} else {
				out.push(new PlainText(b.text));
			}
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			out.push(new PlainText(ansi.dim(ansi.italic(b.thinking))));
		} else if (b.type === "toolCall" && typeof b.name === "string" && typeof b.id === "string") {
			out.push(new ToolCallLine(b.id, b.name, b.arguments, tools));
		}
	}
	return out;
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
