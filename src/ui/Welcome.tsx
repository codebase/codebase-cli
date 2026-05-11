import { execSync } from "node:child_process";
import { basename } from "node:path";
import { Box, Text } from "ink";
import { PixelC } from "./PixelC.js";

/**
 * Best-effort git probe for the welcome banner. Returns null if the
 * cwd isn't a git repo (or if `git` isn't on PATH), so non-git
 * projects get a cleaner banner instead of an empty line. We swallow
 * all errors — the banner is decorative; a slow / failing git
 * shouldn't block startup.
 */
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

/** Humanize an absolute timestamp into "5m ago" / "3h ago" / "2d ago" — sub-minute reads as "just now". */
function formatAgo(ts: number): string {
	const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (sec < 60) return "just now";
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

interface WelcomeProps {
	modelName: string;
	source: string;
	cwd: string;
	/** Set when the session resumed from a prior run — shows a small "Resumed from …" badge. */
	resumedFrom?: { updatedAt: number; messageCount: number };
}

/**
 * Empty-state banner shown above the input while the transcript is
 * empty. Pixel-C logo on the left, contextual info + tips on the
 * right. Renders once and gets pushed up by the first user message —
 * not Static-rendered, but only a few rows so it's cheap.
 */
export function Welcome({ modelName, source, cwd, resumedFrom }: WelcomeProps) {
	const cwdLabel = basename(cwd) || cwd;
	const sourceLabel = source === "proxy" ? "signed in via codebase.design" : source === "byok" ? "BYOK" : `${source}`;
	const gitInfo = readGitInfo(cwd);

	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			<Box flexDirection="row">
				<Box marginRight={2}>
					<PixelC animate={false} />
				</Box>
				<Box flexDirection="column" justifyContent="center">
					<Text bold color="cyan">
						codebase
					</Text>
					<Text dimColor>{modelName}</Text>
					<Text dimColor>
						{cwdLabel} · {sourceLabel}
					</Text>
					{gitInfo ? (
						<Text dimColor>
							{gitInfo.branch}
							{gitInfo.dirty > 0
								? ` · ${gitInfo.dirty} uncommitted change${gitInfo.dirty === 1 ? "" : "s"}`
								: " · clean"}
						</Text>
					) : null}
				</Box>
			</Box>
			{resumedFrom ? (
				<Box marginTop={1}>
					<Text color="cyan">↻ Resumed from {formatAgo(resumedFrom.updatedAt)}</Text>
					<Text dimColor>
						{" "}
						· {resumedFrom.messageCount} message{resumedFrom.messageCount === 1 ? "" : "s"}
					</Text>
				</Box>
			) : null}
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Ask me to read code, edit files, run commands, or anything in between.</Text>
				<Text dimColor>
					<Text color="cyan">/</Text> commands · <Text color="cyan">!</Text>shell · <Text color="cyan">↑↓</Text>{" "}
					history · <Text color="cyan">Tab</Text> complete · <Text color="cyan">\</Text>+Enter for newline
				</Text>
				<Text dimColor>Ctrl-C twice to exit.</Text>
			</Box>
		</Box>
	);
}
