import { execSync } from "node:child_process";
import { basename } from "node:path";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { VERSION } from "../version.js";
import { ansi } from "./theme.js";

interface WelcomeProps {
	modelName: string;
	source: string;
	cwd: string;
	/** Set when the session resumed from a prior run — shows a small "Resumed from …" badge. */
	resumedFrom?: { updatedAt: number; messageCount: number };
}

/**
 * Static pixel-C brand mark. 5-row × 4-col grid mirroring
 * web/public/favicon.svg: 9 filled pixels (3 top + 3 left + 3 bottom)
 * each rendered as two block chars so the shape reads proportionally
 * in a 1:2 cell-ratio terminal.
 */
const FILL = "██";
const GAP = "  ";
const PIXEL_C_ROWS: readonly string[] = [
	`${GAP}${FILL}${FILL}${FILL}`,
	FILL,
	FILL,
	FILL,
	`${GAP}${FILL}${FILL}${FILL}`,
];

/**
 * Empty-state welcome banner shown at the top of a fresh chat. Mirrors
 * the ink-era Welcome: PixelC logo on the left, model + cwd + git +
 * auth source in a column on the right, "what you can do" hints
 * underneath the whole header.
 *
 * Pi-tui doesn't ship a flex / row layout, so we implement render()
 * ourselves to draw the two columns side by side. The hint block is
 * a normal vertical list of lines after the row block.
 */
export class WelcomeBanner implements Component {
	private readonly logoRows: string[];
	private readonly infoRows: string[];
	private readonly hintRows: string[];

	constructor(props: WelcomeProps) {
		this.logoRows = PIXEL_C_ROWS.map((r) => ansi.bold(ansi.cyan(r)));

		const cwdLabel = basename(props.cwd) || props.cwd;
		const sourceLabel =
			props.source === "proxy" ? "signed in via codebase.design" : props.source === "byok" ? "BYOK" : props.source;
		const gitInfo = readGitInfo(props.cwd);

		const info: string[] = [];
		info.push(`${ansi.bold(ansi.cyan("codebase"))} ${ansi.dim(`v${VERSION}`)}`);
		info.push(ansi.dim(props.modelName));
		info.push(ansi.dim(`${cwdLabel} · ${sourceLabel}`));
		if (gitInfo) {
			const dirtyPart =
				gitInfo.dirty > 0 ? ` · ${gitInfo.dirty} uncommitted change${gitInfo.dirty === 1 ? "" : "s"}` : " · clean";
			info.push(ansi.dim(`${gitInfo.branch}${dirtyPart}`));
		}
		if (props.resumedFrom) {
			info.push(
				`${ansi.cyan("↻ Resumed from")} ${ansi.cyan(formatAgo(props.resumedFrom.updatedAt))}${ansi.dim(
					` · ${props.resumedFrom.messageCount} messages`,
				)}`,
			);
		}
		this.infoRows = info;

		this.hintRows = [
			"",
			ansi.dim("Ask me to read code, edit files, run commands, or anything in between."),
			ansi.dim(
				`${ansi.cyan("/")} commands · ${ansi.cyan("!")}shell · ${ansi.cyan("↑↓")} history · ${ansi.cyan("Tab")} complete · ${ansi.cyan("\\")}+Enter newline`,
			),
			ansi.dim("Ctrl-C twice to exit."),
			"",
		];
	}

	render(_width: number): string[] {
		const out: string[] = [];
		const logoWidth = this.logoRows.reduce((max, r) => Math.max(max, visibleWidth(r)), 0);
		const gutter = "  "; // 2-col gap between logo and text column
		const rows = Math.max(this.logoRows.length, this.infoRows.length);
		for (let i = 0; i < rows; i++) {
			const logoLine = this.logoRows[i] ?? "";
			const pad = " ".repeat(Math.max(0, logoWidth - visibleWidth(logoLine)));
			const infoLine = this.infoRows[i] ?? "";
			out.push(` ${logoLine}${pad}${gutter}${infoLine}`);
		}
		for (const hint of this.hintRows) out.push(` ${hint}`);
		return out;
	}

	invalidate(): void {
		// Static content — nothing to recompute.
	}
}

function readGitInfo(cwd: string): { branch: string; dirty: number } | null {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!branch) return null;
		const status = execSync("git status --porcelain", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const dirty = status.split("\n").filter((l) => l.trim().length > 0).length;
		return { branch, dirty };
	} catch {
		return null;
	}
}

function formatAgo(ts: number): string {
	const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (sec < 60) return "just now";
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}
