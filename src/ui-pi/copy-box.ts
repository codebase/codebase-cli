import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type CopyRegistry, encodeSentinel } from "./copy-targets.js";
import { ansi } from "./theme.js";

/**
 * A bordered, click-to-copy box for content the agent emits — a code
 * block or a `present_copy` payload. Every rendered line is prefixed with
 * the box's invisible position sentinel (see copy-targets), so a click
 * anywhere inside it resolves back to this box and copies its exact text.
 *
 * Display is allowed to be lossy (long lines truncate with …); the COPIED
 * text is always the full clean `content` from the registry, never what's
 * painted. That's the whole point — no wrap artifacts in the clipboard.
 */
export class CopyBox implements Component {
	constructor(
		private readonly registry: CopyRegistry,
		/** Stable dedupe key so the id survives re-renders (e.g. "msg-3:block-1"). */
		private readonly key: string,
		private readonly label: string,
		private readonly content: string,
	) {}

	render(width: number): string[] {
		const id = this.registry.idFor(this.key);
		this.registry.set(id, this.content);
		const sentinel = encodeSentinel(id);

		const w = Math.max(24, width);
		const badge = ansi.cyan("⎘ copy");
		const left = `╭─ ${this.label} `;
		const right = ` ${badge} ╮`;
		const fillLen = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
		const top =
			ansi.dim("╭─ ") + ansi.bold(this.label) + ansi.dim(` ${"─".repeat(fillLen)} `) + badge + ansi.dim(" ╮");

		const lines: string[] = [top];
		const inner = Math.max(10, w - 2);
		const bar = ansi.dim("│ ");
		for (const raw of this.content.split("\n")) {
			// Wrap-then-truncate isn't needed: the clipboard gets the full
			// content regardless, so a single visually-clipped line per source
			// line keeps the box compact.
			const shown = visibleWidth(raw) > inner ? `${sliceToWidth(raw, inner - 1)}…` : raw;
			lines.push(`${bar}${shown}`);
		}
		lines.push(ansi.dim(`╰${"─".repeat(Math.max(0, w - 1))}╯`));

		return lines.map((l) => sentinel + l);
	}

	invalidate(): void {}
}

/** Truncate a plain string to a visible width (no ANSI in code-box content). */
function sliceToWidth(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	// wrapTextWithAnsi gives us the first display row at the target width.
	const rows = wrapTextWithAnsi(text, maxWidth);
	return rows[0] ?? text.slice(0, maxWidth);
}
