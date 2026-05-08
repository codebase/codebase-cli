#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { render } from "ink";
import { runAuthSubcommand } from "./auth/cli.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { runHeadless } from "./headless/run.js";
import { App } from "./ui/App.js";

// Auto-load .env files before any subsystem reads process.env.
loadDotEnv();

const argv = process.argv.slice(2);

if (argv[0] === "--version" || argv[0] === "-v") {
	process.stdout.write(`${readPackageVersion()}\n`);
	process.exit(0);
} else if (argv[0] === "--help" || argv[0] === "-h") {
	printHelp();
	process.exit(0);
} else if (argv[0] === "auth") {
	runAuthSubcommand(argv).then((code) => process.exit(code));
} else if (argv[0] === "run") {
	const prompt = argv.slice(1).join(" ").trim();
	if (!prompt) {
		process.stderr.write("usage: codebase run <prompt>\n");
		process.exit(2);
	}
	runHeadless({ prompt }).then((code) => process.exit(code));
} else {
	const instance = render(<App />);
	instance.waitUntilExit().catch(() => {
		process.exit(1);
	});
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
			"  codebase auth login          sign in via codebase.foundation OAuth",
			"  codebase auth logout         revoke the current session",
			"  codebase auth status         show current sign-in",
			"  codebase auth refresh        force-refresh the access token",
			"  codebase auth <cbk_xxx>      save a manual API key (for SSH / headless)",
			"  codebase --version           print version and exit",
			"  codebase --help              show this message",
			"",
			"More: https://github.com/codebase-foundation/codebase-cli",
			"",
		].join("\n"),
	);
}
