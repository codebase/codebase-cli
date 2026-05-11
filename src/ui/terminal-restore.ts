import type { Instance } from "ink";

/**
 * Restore the terminal to a sane state on exit, including the unhappy
 * paths Ink doesn't catch — uncaught exceptions, SIGINT, SIGTERM, and
 * any unmount that happens with raw mode still engaged.
 *
 * Without this, a thrown error inside the React tree (or a kill -9 to
 * a parent shell) leaves the terminal in raw mode with the cursor
 * hidden and ANSI attributes still set, and the user has to type
 * `stty sane` blind to recover. Production-grade TUIs always install
 * these handlers; this is table-stakes hygiene.
 */

const RESET_SEQUENCE =
	// Show cursor.
	"\x1b[?25h" +
	// Reset all SGR attributes (color, bold, italic, etc.).
	"\x1b[0m" +
	// Disable bracketed paste mode if we ever enabled it.
	"\x1b[?2004l";

let installed = false;

export function installTerminalRestoreHandlers(instance?: Instance): void {
	if (installed) return;
	installed = true;

	let restored = false;
	const restore = (): void => {
		if (restored) return;
		restored = true;
		try {
			instance?.unmount();
		} catch {
			// unmount can throw if Ink is already torn down; ignore.
		}
		try {
			// Belt and suspenders: write the reset directly to the TTY in
			// case Ink's unmount didn't (e.g. because we got here via
			// uncaughtException before Ink even mounted).
			if (process.stdout.isTTY) process.stdout.write(RESET_SEQUENCE);
		} catch {
			// Best-effort; the process is going down regardless.
		}
		try {
			// If raw mode is somehow still on (Ink should disable it on
			// unmount, but uncaught exceptions can skip that path), turn
			// it off so the user gets a usable shell back.
			if (process.stdin.isTTY && process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		} catch {
			// Ignore — stdin may already be detached.
		}
	};

	process.once("exit", restore);
	process.once("SIGINT", () => {
		restore();
		// Mirror the default SIGINT exit code so parent shells see it.
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		restore();
		process.exit(143);
	});
	process.once("SIGHUP", () => {
		restore();
		process.exit(129);
	});
	process.on("uncaughtException", (err) => {
		restore();
		process.stderr.write(
			`\nuncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		restore();
		const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
		process.stderr.write(`\nunhandled rejection: ${msg}\n`);
		process.exit(1);
	});
}
