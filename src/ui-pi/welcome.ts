import { execSync } from "node:child_process";
import { basename } from "node:path";
import { Container, Text } from "@mariozechner/pi-tui";
import { ansi } from "./theme.js";

interface WelcomeProps {
	modelName: string;
	source: string;
	cwd: string;
	/** Set when the session resumed from a prior run — shows a small "Resumed from …" badge. */
	resumedFrom?: { updatedAt: number; messageCount: number };
}

/**
 * Empty-state welcome banner shown at the top of a fresh chat. Mirrors
 * the ink-era Welcome — model + cwd + git + auth source on the left,
 * "what you can do" hints below. Pure render (no animation), so we
 * build it once at App construction and let pi-tui's line-diff renderer
 * handle the redraw when the surrounding transcript scrolls it out of
 * view.
 */
export class WelcomeBanner extends Container {
	constructor(props: WelcomeProps) {
		super();
		const cwdLabel = basename(props.cwd) || props.cwd;
		const sourceLabel =
			props.source === "proxy" ? "signed in via codebase.design" : props.source === "byok" ? "BYOK" : props.source;
		const gitInfo = readGitInfo(props.cwd);

		this.addChild(new Text(ansi.bold(ansi.cyan("codebase")), 1, 0));
		this.addChild(new Text(ansi.dim(props.modelName), 1, 0));
		this.addChild(new Text(ansi.dim(`${cwdLabel} · ${sourceLabel}`), 1, 0));
		if (gitInfo) {
			const dirtyPart =
				gitInfo.dirty > 0 ? ` · ${gitInfo.dirty} uncommitted change${gitInfo.dirty === 1 ? "" : "s"}` : " · clean";
			this.addChild(new Text(ansi.dim(`${gitInfo.branch}${dirtyPart}`), 1, 0));
		}
		if (props.resumedFrom) {
			this.addChild(new Text("", 1, 0));
			this.addChild(
				new Text(
					`${ansi.cyan("↻ Resumed from")} ${ansi.cyan(formatAgo(props.resumedFrom.updatedAt))}` +
						ansi.dim(` · ${props.resumedFrom.messageCount} messages`),
					1,
					0,
				),
			);
		}
		this.addChild(new Text("", 1, 0));
		this.addChild(new Text(ansi.dim("Ask me to read code, edit files, run commands, or anything in between."), 1, 0));
		this.addChild(
			new Text(
				ansi.dim(
					`${ansi.cyan("/")} commands · ${ansi.cyan("!")}shell · ${ansi.cyan("↑↓")} history · ${ansi.cyan("Tab")} complete · ${ansi.cyan("\\")}+Enter newline`,
				),
				1,
				0,
			),
		);
		this.addChild(new Text(ansi.dim("Ctrl-C twice to exit."), 1, 0));
		this.addChild(new Text("", 1, 0));
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
