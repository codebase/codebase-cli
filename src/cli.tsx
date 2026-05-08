#!/usr/bin/env node
import { render } from "ink";
import { runAuthSubcommand } from "./auth/cli.js";
import { loadDotEnv } from "./dotenv/loader.js";
import { runHeadless } from "./headless/run.js";
import { App } from "./ui/App.js";

// Auto-load .env files before any subsystem reads process.env.
loadDotEnv();

const argv = process.argv.slice(2);

if (argv[0] === "auth") {
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
