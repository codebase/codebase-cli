import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { ConfigError } from "../agent/config.js";
import { App } from "./app.js";

/**
 * Entry point for the pi-tui render path (CODEBASE_PI_TUI=1). Mirrors
 * `render(<App />)` from cli.tsx's ink path but constructs a pi-tui
 * TUI with our root `App` Container instead. Returns when the App
 * resolves its exit promise.
 *
 * This is intentionally minimal during the migration — the real
 * agent wiring lives in `App`. Anything terminal-specific (raw mode,
 * keyboard protocol, redraw triggers) is delegated to ProcessTerminal
 * + TUI; we just orchestrate the lifecycle.
 */
export async function runPiTuiApp(): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	let app: App | undefined;
	try {
		app = new App();
	} catch (err) {
		if (err instanceof ConfigError) {
			// No provider configured: surface the config error and exit so
			// the user can run `codebase auth login` or set env vars. This
			// matches the ink path's FirstRunSetup fallback (which we don't
			// have a pi-tui version of yet).
			process.stderr.write(`\nConfiguration error: ${err.message}\n`);
			process.stderr.write("Run `codebase auth login` or set a provider env var (ANTHROPIC_API_KEY, etc.).\n");
			return;
		}
		throw err;
	}

	tui.addChild(app);
	tui.start();

	// Resolve when the user signals exit (Ctrl-C twice, /exit). The App
	// owns the exit promise so it can dispose cleanly first.
	await app.waitForExit();

	tui.stop();
	await terminal.drainInput().catch(() => undefined);
}
