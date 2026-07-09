#!/usr/bin/env node
import { render } from "ink";
import { runAppServer } from "./app-server/server.js";
import { runAuthSubcommand } from "./auth/cli.js";
import { ensureFreshCredentials } from "./auth/ensure-fresh.js";
import { fetchUsageReport } from "./commands/builtins/usage.js";
import { buildDoctorReport } from "./diagnostics/doctor.js";
import { runDirectorSubcommand } from "./directors/cli.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { runReceiptSubcommand } from "./headless/receipt-cli.js";
import { type HeadlessOutputFormat, runHeadless } from "./headless/run.js";
import { runProjectSubcommand } from "./projects/cli.js";
import { runSshSubcommand } from "./ssh/cli.js";
import { App } from "./ui/App.js";
import { installTerminalRestoreHandlers } from "./ui/terminal-restore.js";
import { setTerminalTitle } from "./ui/terminal-title.js";
import { VERSION } from "./version.js";

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
	reliable?: boolean;
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
} else if (argv[0] === "web-build") {
	runProjectSubcommand(["project", "build", ...argv.slice(1)]).then((code) => process.exit(code));
} else if (argv[0] === "usage") {
	if (argv[1] === "--help" || argv[1] === "-h") {
		process.stdout.write("usage: codebase usage\n\nShow Codebase plan credits, reset date, and build turns.\n");
		process.exit(0);
	}
	fetchUsageReport().then((report) => {
		process.stdout.write(`${report}\n`);
		process.exit(0);
	});
} else if (argv[0] === "doctor") {
	if (argv[1] === "--help" || argv[1] === "-h") {
		process.stdout.write("usage: codebase doctor\n\nDiagnose local runtime, auth, config, MCP, and storage.\n");
		process.exit(0);
	}
	process.stdout.write(`${buildDoctorReport({ cwd: process.cwd() }).join("\n")}\n`);
	process.exit(0);
} else if (argv[0] === "mcp") {
	printMcpHelp();
	process.exit(0);
} else if (argv[0] === "director" || argv[0] === "directors") {
	runDirectorSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "receipt" || argv[0] === "receipts") {
	runReceiptSubcommand(argv).then((code) => process.exit(code));
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
	if (argv.slice(1).some((a) => a === "--help" || a === "-h")) {
		printRunHelp();
		process.exit(0);
	}
	const { prompt, outputFormat, autoApprove, reliable, error } = parseRunArgs(argv.slice(1));
	if (error) {
		process.stderr.write(`${error}\n`);
		process.exit(2);
	}
	if (!prompt) {
		process.stderr.write(
			"usage: codebase run [--output text|json|stream-json] [--auto-approve] [--reliable] <prompt>\n",
		);
		process.exit(2);
	}
	await ensureFreshCredentials();
	settleExitCode(runHeadless({ prompt, outputFormat, autoApprove, reliable }));
} else if (argv[0] === "auto") {
	if (argv.slice(1).some((a) => a === "--help" || a === "-h")) {
		printAutoHelp();
		process.exit(0);
	}
	const { prompt, outputFormat, reliable, error } = parseRunArgs(argv.slice(1));
	if (error) {
		process.stderr.write(`${error}\n`);
		process.exit(2);
	}
	if (!prompt) {
		process.stderr.write("usage: codebase auto [--output text|json|stream-json] [--reliable] <prompt>\n");
		process.exit(2);
	}
	await ensureFreshCredentials();
	settleExitCode(runHeadless({ prompt, outputFormat, autoApprove: true, reliable }));
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
	// pi-tui (differential renderer, no React) is the default. It has the
	// full feature set plus click-free copy mode, dynamic title, and
	// smoother streaming on long transcripts. CODEBASE_REACT_TUI=1 falls
	// back to the legacy ink path during the deprecation window.
	if (process.env.CODEBASE_REACT_TUI !== "1") {
		const { runPiTuiApp } = await import("./ui-pi/runtime.js");
		installTerminalRestoreHandlers();
		await runPiTuiApp();
		process.exit(0);
	}
	// Legacy ink/React path. Disable ink's default ctrl-c handling — ink
	// unmounts on ctrl-c but doesn't exit the process — leaves the user
	// staring at a frozen terminal. We handle ctrl-c ourselves.
	const instance = render(<App />, { exitOnCtrlC: false });
	installTerminalRestoreHandlers(instance);
	instance.waitUntilExit().catch(() => {
		process.exit(1);
	});
}

function settleExitCode(run: Promise<number>): void {
	run.then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		},
	);
}

function parseRunArgs(args: string[]): ParsedRunArgs {
	const remaining: string[] = [];
	let outputFormat: HeadlessOutputFormat | undefined;
	let autoApprove = false;
	let reliable = false;
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
		if (a === "--reliable") {
			reliable = true;
			continue;
		}
		remaining.push(a);
	}
	const prompt = remaining.join(" ").trim();
	return { prompt: prompt || undefined, outputFormat, autoApprove, reliable };
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
			"  codebase run --auto-approve <prompt>",
			"                               one-shot headless run, prints to stdout",
			"  codebase run --auto-approve --output json|stream-json <prompt>",
			"                               one-shot run with structured output",
			"  codebase run --auto-approve --reliable <prompt>",
			"                               require tasks, verification, and a receipt",
			"  codebase auto <prompt>       shortcut for run --auto-approve",
			"                               one-shot build/change in a trusted workspace",
			"  codebase receipt             inspect the latest reliable-mode receipt",
			"  codebase receipt list        list saved reliable-mode receipts",
			"  codebase auth login          sign in via codebase.design browser OAuth",
			"  codebase auth logout         revoke the current session",
			"  codebase auth status         show current sign-in",
			"  codebase auth refresh        force-refresh the access token",
			"  codebase auth <token>        save a Codebase bearer token (advanced)",
			"  codebase usage               show Codebase plan credits and build turns",
			"  codebase ssh add <name> <host>    enroll a remote machine the agent can target",
			"  codebase ssh list / rm / test     manage enrolled SSH hosts",
			"  codebase ssh keygen <name>        generate an Ed25519 (or --rsa) keypair",
			"  codebase project list        list your projects on codebase.design",
			"  codebase project pull <id>   download a project as a ZIP",
			"  codebase project build <prompt>",
			"                               start a web build on codebase.design",
			"  codebase web-build <prompt>  shortcut for project build",
			"  codebase doctor              diagnose runtime, auth, config, MCP, storage",
			"  codebase mcp                 show MCP setup help",
			"  codebase director list       manage trained directors (hire, status, fire)",
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

function printMcpHelp(): void {
	process.stdout.write(
		[
			"usage: codebase mcp",
			"",
			"Configure MCP servers for codebase.",
			"",
			"Config files:",
			"  ~/.codebase/mcp.json",
			"  <project>/.codebase/mcp.json",
			"",
			"Example:",
			"  {",
			'    "mcpServers": {',
			'      "filesystem": {',
			'        "command": "npx",',
			'        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]',
			"      },",
			'      "remote": {',
			'        "url": "https://mcp.example.com/sse",',
			'        "headers": { "Authorization": "Bearer <token>" }',
			"      }",
			"    }",
			"  }",
			"",
			"Restart codebase after editing config. Inside the TUI, run /mcp to see",
			"connected servers, tools, resources, and prompts.",
			"",
		].join("\n"),
	);
}

function printRunHelp(): void {
	process.stdout.write(
		[
			"usage: codebase run [--output text|json|stream-json] [--auto-approve] [--reliable] <prompt>",
			"",
			"Run one non-interactive agent turn and print the result to stdout.",
			"",
			"Options:",
			"  --output, -o text|json|stream-json   choose stdout format (default: text)",
			"  --auto-approve, --yes, -y            required: allow tool calls without interactive prompts",
			"  --reliable                           fail without completed tasks + verification receipt",
			"  --help, -h                           show this help",
			"",
			"Shortcut:",
			"  codebase auto <prompt>               same as run --auto-approve <prompt>",
			"",
		].join("\n"),
	);
}

function printAutoHelp(): void {
	process.stdout.write(
		[
			"usage: codebase auto [--output text|json|stream-json] [--reliable] <prompt>",
			"",
			"Run one trusted, non-interactive coding task with tool calls auto-approved.",
			"",
			"Equivalent to:",
			"  codebase run --auto-approve <prompt>",
			"",
			"Options:",
			"  --output, -o text|json|stream-json   choose stdout format (default: text)",
			"  --reliable                           fail without completed tasks + verification receipt",
			"  --help, -h                           show this help",
			"",
		].join("\n"),
	);
}
