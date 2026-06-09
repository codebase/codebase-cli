#!/usr/bin/env node
import { render } from "ink";
import { runAppServer } from "./app-server/server.js";
import { runAuthSubcommand } from "./auth/cli.js";
import { ensureFreshCredentials } from "./auth/ensure-fresh.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { type HeadlessOutputFormat, runHeadless } from "./headless/run.js";
import { runProjectSubcommand } from "./projects/cli.js";
import { runSshSubcommand } from "./ssh/cli.js";
import { App } from "./ui/App.js";
import { installTerminalRestoreHandlers } from "./ui/terminal-restore.js";
import { VERSION } from "./version.js";
import { setTerminalTitle } from "./ui/terminal-title.js";

// Auto-load .env files before any subsystem reads process.env.
loadDotEnv();

// Module-level consts referenced by `parseRunArgs`. Declared BEFORE
// the dispatch block below — `const` lives in the temporal dead zone
// until its declaration runs, so the dispatch can't reach `parseRunArgs`
// → `VALID_OUTPUT_FORMATS` until both have initialized.
interface ParsedRunArgs {
	prompt?: string;
	outputFormat?: HeadlessOutputFormat;
	autoApprove?: boolean;
	error?: string;
}

const VALID_OUTPUT_FORMATS = new Set<HeadlessOutputFormat>(["text", "json", "stream-json"]);

const rawArgv = process.argv.slice(2);

// Strip flags consumed at the top-level dispatcher before subcommand
// matching. `--debug-input` is one of those: it sets an env var that
// the Input component picks up, then disappears from argv so it can't
// confuse downstream parsers.
const argv: string[] = [];
for (const a of rawArgv) {
	if (a === "--debug-input") {
		process.env.CODEBASE_DEBUG_INPUT = "1";
		continue;
	}
	if (a === "--new" || a === "--fresh") {
		// Skip the auto-resume that the interactive TUI does by default —
		// useful when the prior session is no longer relevant or after a
		// destructive change to the working tree.
		process.env.CODEBASE_FRESH = "1";
		continue;
	}
	if (a === "--unrestricted" || a === "--yolo") {
		// Power-user mode: drops every soft-guard restriction. Equivalent
		// to setting CODEBASE_NO_PROJECT_ROOT=1 + CODEBASE_NO_VALIDATOR=1
		// + CODEBASE_NO_READ_BEFORE_WRITE=1. The agent can then read/write
		// anywhere, run any shell command, and overwrite files without
		// reading them first. Use when you trust the model + the prompt
		// (e.g. your own machine, your own project). The warning banner
		// at session start enumerates what's off so it's never accidental.
		process.env.CODEBASE_NO_PROJECT_ROOT = "1";
		process.env.CODEBASE_NO_VALIDATOR = "1";
		process.env.CODEBASE_NO_READ_BEFORE_WRITE = "1";
		continue;
	}
	argv.push(a);
}

if (argv[0] === "--version" || argv[0] === "-v") {
	process.stdout.write(`${VERSION}\n`);
	process.exit(0);
} else if (argv[0] === "--help" || argv[0] === "-h") {
	printHelp();
	process.exit(0);
} else if (argv[0] === "auth") {
	runAuthSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "ssh") {
	runSshSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "project" || argv[0] === "projects") {
	runProjectSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "app-server") {
	// JSON-RPC-ish over stdio for IDE extensions. Auto-approve permissions
	// by default — IDE clients render approval UIs themselves and we don't
	// want the server to hang waiting on a TUI prompt no one's watching.
	// The `--no-auto-approve` flag is for clients that DO implement their
	// own approval flow via the `permission_request` event.
	const noAutoApprove = argv.includes("--no-auto-approve");
	const resume = argv.includes("--resume");
	// Refresh the saved access token if it's expired since the last
	// launch (proxy session, valid refresh token sitting next to it).
	// Otherwise createAgent would synchronously bail at "no usable
	// provider" and the IDE would see a setup_error envelope instead
	// of a working server.
	await ensureFreshCredentials();
	runAppServer({ autoApprove: !noAutoApprove, resume }).then((code) => process.exit(code));
} else if (argv[0] === "run") {
	const { prompt, outputFormat, autoApprove, error } = parseRunArgs(argv.slice(1));
	if (error) {
		process.stderr.write(`${error}\n`);
		process.exit(2);
	}
	if (!prompt) {
		process.stderr.write("usage: codebase run [--output text|json|stream-json] [--auto-approve] <prompt>\n");
		process.exit(2);
	}
	await ensureFreshCredentials();
	runHeadless({ prompt, outputFormat, autoApprove }).then((code) => process.exit(code));
} else {
	setTerminalTitle("codebase");
	// Print a one-line warning if any restriction is off so the user can't
	// accidentally launch a session in unrestricted mode without realizing.
	// Written before ink takes over the screen so it appears once at the
	// top, then scrolls away as normal output replaces it.
	printUnrestrictedBanner();
	// Enable bracketed paste mode so the terminal wraps pasted content in
	// CSI 200~ / 201~ markers. terminal-restore.ts emits the matching
	// disable sequence on every exit path.
	if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
	// Cold-start credential refresh. If this is a returning user whose
	// saved access token expired while the laptop was closed, refresh
	// it now using the long-lived refresh token instead of dumping them
	// back to the login wizard. A network failure here is silent — the
	// wizard path catches it downstream.
	await ensureFreshCredentials();
	if (process.env.CODEBASE_PI_TUI === "1") {
		// Opt-in pi-tui render path — differential renderer, no React.
		// During the migration this is feature-gated; the ink path stays
		// default until parity is verified.
		const { runPiTuiApp } = await import("./ui-pi/runtime.js");
		installTerminalRestoreHandlers();
		await runPiTuiApp();
		process.exit(0);
	}
	// Default ink/React path. Disable ink's default ctrl-c handling — ink
	// unmounts on ctrl-c but doesn't exit the process — leaves the user
	// staring at a frozen terminal. We handle ctrl-c ourselves.
	const instance = render(<App />, { exitOnCtrlC: false });
	installTerminalRestoreHandlers(instance);
	instance.waitUntilExit().catch(() => {
		process.exit(1);
	});
}

function parseRunArgs(args: string[]): ParsedRunArgs {
	const remaining: string[] = [];
	let outputFormat: HeadlessOutputFormat | undefined;
	let autoApprove = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--output" || a === "-o") {
			const value = args[i + 1];
			if (!value || !VALID_OUTPUT_FORMATS.has(value as HeadlessOutputFormat)) {
				return { error: `--output must be one of: ${[...VALID_OUTPUT_FORMATS].join(", ")}` };
			}
			outputFormat = value as HeadlessOutputFormat;
			i++;
			continue;
		}
		if (a.startsWith("--output=")) {
			const value = a.slice("--output=".length);
			if (!VALID_OUTPUT_FORMATS.has(value as HeadlessOutputFormat)) {
				return { error: `--output must be one of: ${[...VALID_OUTPUT_FORMATS].join(", ")}` };
			}
			outputFormat = value as HeadlessOutputFormat;
			continue;
		}
		if (a === "--auto-approve" || a === "--yes" || a === "-y") {
			autoApprove = true;
			continue;
		}
		remaining.push(a);
	}
	const prompt = remaining.join(" ").trim();
	return { prompt: prompt || undefined, outputFormat, autoApprove };
}

function printUnrestrictedBanner(): void {
	const off: string[] = [];
	if (process.env.CODEBASE_NO_PROJECT_ROOT === "1") off.push("project-root clamp");
	if (process.env.CODEBASE_NO_VALIDATOR === "1") off.push("shell validator");
	if (process.env.CODEBASE_NO_READ_BEFORE_WRITE === "1") off.push("read-before-write");
	if (off.length === 0) return;
	if (!process.stdout.isTTY) return;
	// Yellow background, black text — visible without being scary-red.
	const banner = `\x1b[43;30m⚠ UNRESTRICTED MODE — ${off.join(" + ")} disabled\x1b[0m`;
	process.stdout.write(`${banner}\n`);
}

function printHelp(): void {
	process.stdout.write(
		[
			"codebase — AI coding agent in your terminal",
			"",
			"Usage:",
			"  codebase                     run the interactive TUI in the current directory",
			"  codebase run <prompt>        one-shot headless run, prints to stdout",
			"  codebase run --output json|stream-json <prompt>",
			"                               one-shot run with structured output",
			"  codebase auth login          sign in via codebase.foundation OAuth",
			"  codebase auth logout         revoke the current session",
			"  codebase auth status         show current sign-in",
			"  codebase auth refresh        force-refresh the access token",
			"  codebase auth <cbk_xxx>      save a manual API key (for SSH / headless)",
			"  codebase ssh add <name> <host>    enroll a remote machine the agent can target",
			"  codebase ssh list / rm / test     manage enrolled SSH hosts",
			"  codebase ssh keygen <name>        generate an Ed25519 (or --rsa) keypair",
			"  codebase project list        list your projects on codebase.design",
			"  codebase project pull <id>   download a project as a ZIP",
			"  codebase app-server          JSON-RPC server on stdio (for IDE extensions)",
			"  codebase --version           print version and exit",
			"  codebase --help              show this message",
			"",
			"Session:",
			"  codebase                     resume the prior session for this directory if recent (≤7d)",
			"  codebase --new               start a fresh session, ignoring saved history",
			"  codebase --unrestricted      drop the project-root clamp, shell validator, and",
			"                               read-before-write check. Trust mode for your own machine.",
			"",
			"Diagnostics:",
			"  --debug-input                log every keystroke to ~/.codebase/logs/input.log",
			"                               (use when reporting a keyboard/terminal issue)",
			"",
			"More: https://github.com/codebase-foundation/codebase-cli",
			"",
		].join("\n"),
	);
}
