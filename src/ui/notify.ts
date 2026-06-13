import { spawn } from "node:child_process";

/**
 * Turn-completion notification. Long agent turns are exactly when you
 * look away, so when a turn finishes after running a while we ring the
 * terminal bell (universal, non-printing) and best-effort fire an OS
 * notification. Quick turns stay silent so it doesn't nag.
 *
 * Opt out with CODEBASE_NO_NOTIFY=1.
 */

/** Default: only notify for turns that ran at least this long. */
const DEFAULT_MIN_MS = 10_000;

/** Pure gate — testable without side effects. */
export function shouldNotify(elapsedMs: number, env: NodeJS.ProcessEnv = process.env, minMs = DEFAULT_MIN_MS): boolean {
	if (env.CODEBASE_NO_NOTIFY === "1") return false;
	return elapsedMs >= minMs;
}

export interface NotifyOptions {
	elapsedMs: number;
	/** One-line summary (e.g. the start of the final assistant message). */
	summary?: string;
	minMs?: number;
	/** Override stdout (tests). */
	stdout?: NodeJS.WritableStream;
	env?: NodeJS.ProcessEnv;
}

export function notifyTurnComplete(opts: NotifyOptions): void {
	const env = opts.env ?? process.env;
	if (!shouldNotify(opts.elapsedMs, env, opts.minMs)) return;
	// BEL: non-printing, doesn't disturb the TUI render.
	(opts.stdout ?? process.stdout).write("\x07");
	fireOsNotification(summaryLine(opts.summary));
}

function summaryLine(summary: string | undefined): string {
	const base = "codebase finished";
	if (!summary) return base;
	const oneLine = summary.replace(/\s+/g, " ").trim();
	if (!oneLine) return base;
	return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

/** Best-effort desktop notification; silent when no notifier exists. */
function fireOsNotification(body: string): void {
	try {
		if (process.platform === "darwin") {
			const script = `display notification ${osaQuote(body)} with title "codebase"`;
			detached("osascript", ["-e", script]);
		} else if (process.platform === "linux") {
			detached("notify-send", ["codebase", body]);
		}
		// Windows: the bell is enough; no dependency-free notifier.
	} catch {
		// Notifications are a nicety — never throw into the agent loop.
	}
}

function detached(cmd: string, args: string[]): void {
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => undefined); // notifier not installed — ignore
		child.unref();
	} catch {
		// spawn threw synchronously (rare) — ignore
	}
}

/** Quote a string for an AppleScript string literal. */
function osaQuote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
