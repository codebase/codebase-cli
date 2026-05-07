#!/usr/bin/env node
import { render } from "ink";
import { App } from "./ui/App.js";

const instance = render(<App />);

instance.waitUntilExit().catch(() => {
	process.exit(1);
});
