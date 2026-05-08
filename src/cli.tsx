#!/usr/bin/env node
import { render } from "ink";
import { runAuthSubcommand } from "./auth/cli.js";
import { App } from "./ui/App.js";

const argv = process.argv.slice(2);

if (argv[0] === "auth") {
	runAuthSubcommand(argv).then((code) => process.exit(code));
} else {
	const instance = render(<App />);
	instance.waitUntilExit().catch(() => {
		process.exit(1);
	});
}
