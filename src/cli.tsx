#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { render } from "ink";
import { runAuthSubcommand } from "./auth/cli.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { type HeadlessOutputFormat, runHeadless } from "./headless/run.js";
import { runProjectSubcommand } from "./projects/cli.js";
import { App } from "./ui/App.js";

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

const argv = process.argv.slice(2);

if (argv[0] === "--version" || argv[0] === "-v") {
	process.stdout.write(`${readPackageVersion()}\n`);
	process.exit(0);
} else if (argv[0] === "--help" || argv[0] === "-h") {
	printHelp();
	process.exit(0);
} else if (argv[0] === "auth") {
	runAuthSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "project" || argv[0] === "projects") {
	runProjectSubcommand(argv).then((code) => process.exit(code));
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
	const instance = render(<App />);
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
			"  codebase project list        list your projects on codebase.design",
			"  codebase project pull <id>   download a project as a ZIP",
			"  codebase --version           print version and exit",
			"  codebase --help              show this message",
			"",
			"More: https://github.com/codebase-foundation/codebase-cli",
			"",
		].join("\n"),
	);
}
