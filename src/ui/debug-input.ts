import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Opt-in raw-input logger. When CODEBASE_DEBUG_INPUT=1 (set by the
 * `--debug-input` flag), every keystroke Ink hands us is appended to
 * `~/.codebase/logs/input.log` as one JSON line. We can ask a user
 * with a wedged keyboard ("backspace doesn't work", "weird chars on
 * paste") to share that file and see exactly what bytes their
 * terminal emitted.
 *
 * No-op when the env var is unset, so production users pay nothing.
 */

interface InkKeyShape {
	readonly leftArrow?: boolean;
	readonly rightArrow?: boolean;
	readonly upArrow?: boolean;
	readonly downArrow?: boolean;
	readonly return?: boolean;
	readonly escape?: boolean;
	readonly ctrl?: boolean;
	readonly shift?: boolean;
	readonly tab?: boolean;
	readonly backspace?: boolean;
	readonly delete?: boolean;
	readonly pageDown?: boolean;
	readonly pageUp?: boolean;
	readonly meta?: boolean;
}

let logPath: string | null = null;
let warned = false;

export function isDebugInputEnabled(): boolean {
	return process.env.CODEBASE_DEBUG_INPUT === "1";
}

function resolveLogPath(): string {
	if (logPath) return logPath;
	const dir = join(homedir(), ".codebase", "logs");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// The fs error is non-fatal; the appendFileSync below will throw
		// the same problem and we'll surface it once via the `warned`
		// guard, not on every keystroke.
	}
	logPath = join(dir, "input.log");
	return logPath;
}

export function logInputEvent(input: string, key: InkKeyShape): void {
	if (!isDebugInputEnabled()) return;
	try {
		const entry = {
			t: new Date().toISOString(),
			// Show the actual code points so a stray \x7f or \x1b is visible.
			input,
			codes: Array.from(input).map((ch) => ch.charCodeAt(0)),
			key,
		};
		appendFileSync(resolveLogPath(), `${JSON.stringify(entry)}\n`);
	} catch (err) {
		if (warned) return;
		warned = true;
		process.stderr.write(
			`\n[debug-input] failed to write log: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}
