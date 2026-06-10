import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolExecution } from "../types.js";
import { ansi } from "./theme.js";

/**
 * Sticky panel showing currently-running tool calls above the input
 * bar. Mirrors the ink path's ToolPanel.tsx — without this, in-flight
 * tools only appear inline under the streaming message and scroll
 * away as soon as the agent settles. The sticky view stays visible
 * so the user knows what's happening when a turn is mid-flight.
 *
 * Reads from a live `tools` Map (the same one App maintains); each
 * render filters for status === "running". When nothing's in flight,
 * render() returns [] so the row collapses.
 *
 * Pi-tui doesn't tick by itself, so App's existing spinner timer
 * (90ms) drives the elapsed counter forward by invalidating us; the
 * 1s-resolution counter is still smooth at that rate.
 */
const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

export class LiveToolPanel implements Component {
	private readonly tools: ReadonlyMap<string, ToolExecution>;
	/** Per-tool preview output lines; default 3 like the ink path. */
	private readonly previewLines: number;

	constructor(tools: ReadonlyMap<string, ToolExecution>, previewLines = 3) {
		this.tools = tools;
		this.previewLines = previewLines;
	}

	render(width: number): string[] {
		const running: ToolExecution[] = [];
		for (const tool of this.tools.values()) {
			if (tool.status === "running") running.push(tool);
		}
		if (running.length === 0) return [];

		const out: string[] = [];
		const frame = SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length];
		for (const tool of running) {
			const elapsed = Math.max(0, Math.round((Date.now() - tool.startedAt) / 1000));
			const argsHint = summarizeArgs(tool.args);
			const header = ` ${ansi.magenta(frame)} ${ansi.bold(ansi.magenta(tool.name))}${
				argsHint ? ansi.dim(` (${argsHint})`) : ""
			}${ansi.dim(` · ${elapsed}s`)}`;
			out.push(header);

			if (tool.result) {
				for (const line of takeTail(tool.result, this.previewLines)) {
					const truncated = truncateForWidth(line, Math.max(20, width - 6));
					out.push(`   ${ansi.dim(truncated)}`);
				}
			}
		}
		return out;
	}

	invalidate(): void {
		// State is read live from `tools` on every render — nothing to
		// recompute here. App's spinner timer drives the redraw.
	}
}

function takeTail(text: string, maxLines: number): string[] {
	const lines = text
		.replace(/\r/g, "")
		.split("\n")
		.filter((l) => l.length > 0);
	return lines.slice(-maxLines);
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 2);
	return entries
		.map(([k, v]) => {
			const s = typeof v === "string" ? `"${truncate(v, 24)}"` : safeJson(v);
			return `${k}=${s}`;
		})
		.join(", ");
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v).slice(0, 24);
	} catch {
		return String(v).slice(0, 24);
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function truncateForWidth(s: string, max: number): string {
	if (visibleWidth(s) <= max) return s;
	// Coarse truncate — counts code units, not graphemes. Good enough
	// for tool output previews.
	return `${s.slice(0, Math.max(0, max - 1))}…`;
}
