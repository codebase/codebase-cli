import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CopyRegistry } from "./copy-targets.js";
import { ansi } from "./theme.js";

/**
 * A bordered copy box for content the agent emits — a code block or a
 * `present_copy` payload. It registers its exact clean text with the
 * CopyRegistry so Ctrl-O's copy picker can push it to the clipboard
 * verbatim (no wrap artifacts), regardless of how the box is displayed.
 *
 * Display is allowed to be lossy (long lines truncate with …); the COPIED
 * text is always the full registered `content`, never what's painted.
 */
export class CopyBox implements Component {
	constructor(
		private readonly registry: CopyRegistry,
		/** Stable dedupe key so the entry survives re-renders (e.g. "msg-3:block-1"). */
		private readonly key: string,
		private readonly label: string,
		private readonly content: string,
	) {}

	render(width: number): string[] {
		this.registry.register(this.key, this.label, this.content);

		const w = Math.max(24, width);
		const hint = ansi.dim("⎘ ^O");
		const left = `╭─ ${this.label} `;
		const right = ` ${hint} ╮`;
		const fillLen = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
		const top =
			ansi.dim("╭─ ") + ansi.bold(this.label) + ansi.dim(` ${"─".repeat(fillLen)} `) + hint + ansi.dim(" ╮");

		const lines: string[] = [top];
		const inner = Math.max(10, w - 2);
		const bar = ansi.dim("│ ");
		for (const raw of this.content.split("\n")) {
			const shown = visibleWidth(raw) > inner ? `${sliceToWidth(raw, inner - 1)}…` : raw;
			lines.push(`${bar}${shown}`);
		}
		lines.push(ansi.dim(`╰${"─".repeat(Math.max(0, w - 1))}╯`));
		return lines;
	}

	invalidate(): void {}
}

/** Truncate a plain string to a visible width (no ANSI in code-box content). */
function sliceToWidth(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const rows = wrapTextWithAnsi(text, maxWidth);
	return rows[0] ?? text.slice(0, maxWidth);
}
