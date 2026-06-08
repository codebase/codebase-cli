import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { ConfigError } from "../agent/config.js";
import { App } from "./app.js";
import { FirstRunWizard } from "./first-run-wizard.js";

/**
 * Entry point for the pi-tui render path (CODEBASE_PI_TUI=1). Mirrors
 * `render(<App />)` from cli.tsx's ink path but constructs a pi-tui
 * TUI with our root `App` Container instead. Returns when the App
 * resolves its exit promise.
 *
 * If createAgent throws ConfigError on the first attempt, mounts the
 * FirstRunWizard so the user can OAuth or paste a BYOK key without
 * having to drop back to a shell.
 */
export async function runPiTuiApp(): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	tui.start();

	// Try to build the agent; if no provider is configured, mount the
	// first-run wizard and rebuild after the user finishes setup.
	let app: App | undefined;
	let attempt = 0;
	while (!app) {
		attempt += 1;
		try {
			app = new App();
		} catch (err) {
			if (!(err instanceof ConfigError)) {
				tui.stop();
				throw err;
			}
			const proceed = await mountWizard(tui);
			if (!proceed) {
				tui.stop();
				return;
			}
			// Loop and retry createAgent now that credentials should exist.
			if (attempt > 3) {
				// Safety: don't infinitely loop if something keeps throwing
				// ConfigError after the wizard saved creds. Surface to stderr
				// and bail.
				tui.stop();
				process.stderr.write(
					`\nConfiguration still invalid after setup: ${err.message}\nRun \`codebase auth status\` to inspect.\n`,
				);
				return;
			}
		}
	}

	tui.addChild(app);
	app.attachToTui(tui);
	// Force a paint now so the welcome banner appears immediately after
	// the wizard tears down (or on cold start). Without this kick the TUI
	// only paints on the next input event.
	tui.requestRender(true);

	// Even if waitForExit throws (an unhandled subscriber error, a
	// terminal disconnect, anything), the TUI must be torn down and the
	// terminal restored — otherwise the user is left in raw mode with a
	// dead UI. Try/finally guarantees app.dispose() + tui.stop() run.
	try {
		await app.waitForExit();
	} finally {
		try {
			app.dispose();
		} catch {
			// dispose throwing shouldn't block tui.stop(); fall through.
		}
		tui.stop();
		await terminal.drainInput().catch(() => undefined);
	}
}

/**
 * Mount the wizard and resolve true if the user successfully
 * authenticated (so createAgent should be re-attempted), false if the
 * user quit. The wizard manages its own lifecycle; this helper just
 * adapts its callbacks into a promise.
 */
function mountWizard(tui: TUI): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const wizard = new FirstRunWizard({
			tui,
			onDone: () => {
				// Tear down the wizard's children from the TUI tree before
				// resolving so the next attempt's App.addChild doesn't
				// stack on top of leftover wizard widgets.
				tui.removeChild(wizard);
				resolve(true);
			},
			onQuit: () => {
				tui.removeChild(wizard);
				resolve(false);
			},
		});
		tui.addChild(wizard);
		const focus = wizard.getFocusTarget();
		if (focus) tui.setFocus(focus);
	});
}
