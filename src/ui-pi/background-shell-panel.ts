import { Container, Text } from "@mariozechner/pi-tui";
import type { BackgroundShellRecord, BackgroundShellStore } from "../tools/background-shell-store.js";
import { ansi } from "./theme.js";

/**
 * Bottom-of-screen panel listing background shells the agent has
 * spawned. Mirrors src/ui/BackgroundShellPanel.tsx — hides itself when
 * empty, hides recently-exited shells after ~10s so the panel stays
 * short.
 */
export class BackgroundShellPanel extends Container {
	private store: BackgroundShellStore;
	private unsubscribe: () => void;
	private shells: readonly BackgroundShellRecord[] = [];
	private prunedAt = Date.now();

	constructor(store: BackgroundShellStore) {
		super();
		this.store = store;
		this.unsubscribe = store.subscribe((next) => {
			this.shells = next;
			this.rebuild();
		});
		this.rebuild();
	}

	/** Re-bind to a fresh BackgroundShellStore after a model swap. */
	rebind(store: BackgroundShellStore): void {
		this.unsubscribe();
		this.store = store;
		this.unsubscribe = store.subscribe((next) => {
			this.shells = next;
			this.rebuild();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	private rebuild(): void {
		// Recompute on every change so exited rows age out naturally.
		this.prunedAt = Date.now();
		const visible = this.shells.filter(
			(s) => s.status === "running" || (s.endedAt && this.prunedAt - s.endedAt < 10_000),
		);
		// Reset children by mutating the internal list (Container doesn't
		// expose removeChild publicly; same pattern as TranscriptView's
		// streaming swap).
		const childrenContainer = this as unknown as { children: unknown[] };
		childrenContainer.children = [];
		if (visible.length === 0) {
			this.invalidate();
			return;
		}
		this.addChild(new Text(ansi.dim("Background shells:"), 1, 0));
		for (const s of visible) this.addChild(new Text(formatRow(s, this.prunedAt), 1, 0));
		this.invalidate();
	}
}

function formatRow(s: BackgroundShellRecord, now: number): string {
	const elapsed = Math.round(((s.endedAt ?? now) - s.startedAt) / 1000);
	let status: string;
	let color: (t: string) => string;
	if (s.status === "running") {
		status = "● running";
		color = ansi.magenta;
	} else if (s.status === "killed") {
		status = `× killed${s.signal ? ` ${s.signal}` : ""}`;
		color = ansi.red;
	} else if (s.exitCode === 0) {
		status = "✓ done";
		color = ansi.green;
	} else {
		status = `✗ exit ${s.exitCode ?? "?"}`;
		color = ansi.red;
	}
	const cmd = s.command.length > 60 ? `${s.command.slice(0, 60)}…` : s.command;
	return `  ${color(status)} · ${ansi.dim(`${s.id} · ${elapsed}s`)} · ${cmd}`;
}
