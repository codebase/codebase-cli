#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { render } from "ink";
import { runAppServer } from "./app-server/server.js";
import { runAuthSubcommand } from "./auth/cli.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { type HeadlessOutputFormat, runHeadless } from "./headless/run.js";
import { runProjectSubcommand } from "./projects/cli.js";
import { runSshSubcommand } from "./ssh/cli.js";
import { App } from "./ui/App.js";
import { installTerminalRestoreHandlers } from "./ui/terminal-restore.js";
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
	argv.push(a);
}

if (argv[0] === "--version" || argv[0] === "-v") {
	process.stdout.write(`${readPackageVersion()}\n`);
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
	runHeadless({ prompt, outputFormat, autoApprove }).then((code) => process.exit(code));
} else {
	setTerminalTitle("codebase");
	// Enable bracketed paste mode so the terminal wraps pasted content in
	// CSI 200~ / 201~ markers. The Input component listens for them and
	// collapses the content into a placeholder. terminal-restore.ts emits
	// the matching disable sequence on every exit path.
	if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
	// Disable ink's default ctrl-c handling. ink unmounts on ctrl-c but
	// doesn't exit the process — leaves the user staring at a frozen
	// terminal. We handle ctrl-c ourselves: first press aborts the agent
	// and any in-flight overlay, a second press within 1s exits cleanly.
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

function readPackageVersion(): string {
	// dist/cli.js → ../package.json. Works for tsc-emitted output; if
	// we ever ship a bundled binary this needs to switch to a build-time
	// version constant.
	try {
		const url = new URL("../package.json", import.meta.url);
		const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
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
