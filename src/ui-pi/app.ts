import { Container, Text } from "@mariozechner/pi-tui";
import { type AgentBundle, createAgent } from "../agent/agent.js";

/**
 * Root pi-tui component for the codebase CLI. Mirrors ink/App.tsx in
 * responsibilities — agent bundle, reducer, lifecycle effects, render
 * tree — but expressed as a single Container with child components
 * we add/remove imperatively as state changes.
 *
 * Migration phase 0: bare scaffold. Boots an agent, prints a welcome
 * line + the current model, exits on Ctrl-C. Real wiring follows in
 * phases 1+.
 */
export class App extends Container {
	private readonly bundle: AgentBundle;
	private exitResolve: (() => void) | undefined;
	private readonly exitPromise: Promise<void>;
	private exitArmedAt = 0;

	constructor() {
		super();
		// resolveConfig may throw ConfigError; runtime catches that and
		// shows a setup hint. Other errors propagate.
		this.bundle = createAgent({ resume: process.env.CODEBASE_FRESH !== "1" });
		this.exitPromise = new Promise<void>((resolve) => {
			this.exitResolve = resolve;
		});

		this.addChild(new WelcomeBanner(this.bundle.model.name));
		this.addChild(new HintLine());
	}

	waitForExit(): Promise<void> {
		return this.exitPromise;
	}

	handleInput(data: string): void {
		// Ctrl-C: first press arms a 1s exit window, second press within
		// that window exits cleanly. Same double-tap semantics as the
		// ink path, but delivered directly via the input pipe (not
		// captured by a React useEffect).
		if (data === "\x03") {
			const now = Date.now();
			if (now - this.exitArmedAt < 1000) {
				this.exitResolve?.();
				return;
			}
			this.exitArmedAt = now;
			return;
		}
		// All other input is dropped for phase 0. Phase 1 attaches an
		// Editor as a focused child and forwards there.
	}
}

class WelcomeBanner extends Container {
	private readonly line: Text;
	constructor(modelName: string) {
		super();
		this.line = new Text(`codebase · ${modelName}`);
		this.addChild(this.line);
	}
}

class HintLine extends Container {
	constructor() {
		super();
		this.addChild(new Text("(pi-tui phase 0 — Ctrl-C twice to exit)"));
	}
}
