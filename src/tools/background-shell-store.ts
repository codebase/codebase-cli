import { type ChildProcess, spawn } from "node:child_process";

const MAX_BUFFER_BYTES = 64 * 1024; // 64KB rolling buffer per shell

export interface BackgroundShellRecord {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "exited" | "killed";
	exitCode?: number;
	signal?: NodeJS.Signals;
	/** Captured stdout+stderr, head-truncated when past MAX_BUFFER_BYTES. */
	output: string;
	/** Total bytes ever emitted (across head-truncated history) — lets callers detect truncation. */
	bytesEmitted: number;
}

export type BackgroundShellListener = (shells: readonly BackgroundShellRecord[]) => void;

/**
 * Result returned by `BackgroundShellStore.kill`. The caller needs to know
 * whether the process actually went down; a previous void return swallowed
 * the difference between "killed cleanly", "wasn't there", and "tried to
 * signal but the OS said no" — that hid real bugs in tool callers.
 */
export type BackgroundShellKillResult =
	| { outcome: "killed"; signal: "SIGTERM" | "SIGKILL" }
	| { outcome: "not-found" }
	| { outcome: "already-exited" }
	| { outcome: "signal-failed" };

/**
 * Tracks long-running shell processes that the agent spawned with
 * `shell({ background: true })`. The agent's tool turn returns
 * immediately with a `task_id`; the process keeps running in the
 * background, output streams into a rolling buffer here, and the
 * agent can poll via `shell_output` or terminate via `shell_kill`.
 *
 * Cleanup invariant: every spawned process is SIGTERM'd on app exit
 * via terminal-restore so we don't leak children when the CLI quits.
 */
export class BackgroundShellStore {
	private records = new Map<string, BackgroundShellRecord>();
	private processes = new Map<string, ChildProcess>();
	private readonly listeners = new Set<BackgroundShellListener>();
	private nextId = 1;

	/**
	 * Spawn a detached shell. Returns the new record immediately —
	 * caller doesn't wait for the process to do anything. The shell
	 * runs via `sh -c` so the command string can contain pipes /
	 * redirects / etc., the same surface a normal `shell` tool call has.
	 */
	spawn(command: string, cwd: string): BackgroundShellRecord {
		const id = `bg-${this.nextId++}`;
		const record: BackgroundShellRecord = {
			id,
			command,
			cwd,
			startedAt: Date.now(),
			status: "running",
			output: "",
			bytesEmitted: 0,
		};
		const child = spawn(command, {
			shell: true,
			cwd,
			env: process.env,
			detached: false, // we want to track and kill on exit, not orphan
			stdio: ["ignore", "pipe", "pipe"],
		});

		const onChunk = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			record.bytesEmitted += chunk.byteLength;
			record.output += text;
			// Trim head when the rolling buffer exceeds the cap. Lose the
			// oldest output, keep the most recent — that's almost always
			// what's relevant (errors and recent state).
			if (record.output.length > MAX_BUFFER_BYTES) {
				record.output = record.output.slice(record.output.length - MAX_BUFFER_BYTES);
			}
			this.notify();
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("exit", (code, signal) => {
			record.endedAt = Date.now();
			record.status = signal === "SIGTERM" || signal === "SIGKILL" ? "killed" : "exited";
			record.exitCode = code ?? undefined;
			record.signal = signal ?? undefined;
			this.processes.delete(id);
			this.notify();
		});
		child.on("error", (err) => {
			record.output += `\n[spawn error: ${err.message}]\n`;
			record.endedAt = Date.now();
			record.status = "exited";
			record.exitCode = -1;
			this.processes.delete(id);
			this.notify();
		});

		this.records.set(id, record);
		this.processes.set(id, child);
		this.notify();
		return { ...record };
	}

	/**
	 * Read the current state of a tracked shell. Returns a copy so
	 * callers can't mutate the live record. Returns undefined for
	 * unknown ids.
	 */
	get(id: string): BackgroundShellRecord | undefined {
		const record = this.records.get(id);
		return record ? { ...record } : undefined;
	}

	/** All known shells, oldest-first. Returns copies. */
	list(): readonly BackgroundShellRecord[] {
		return Array.from(this.records.values()).map((r) => ({ ...r }));
	}

	/**
	 * Terminate a running shell. SIGTERM first; if the process is still
	 * around after `gracePeriodMs`, SIGKILL. Resolves once the exit
	 * handler has fired.
	 *
	 * Returns a structured result so the caller can act on the outcome:
	 *   - `"killed"`         — process exited after our signal
	 *   - `"not-found"`      — unknown id
	 *   - `"already-exited"` — id known but the process had already left
	 *   - `"signal-failed"`  — both SIGTERM and SIGKILL threw (rare; e.g.
	 *                          stale PID reuse). Likely already dead.
	 */
	async kill(id: string, gracePeriodMs = 2000): Promise<BackgroundShellKillResult> {
		// Order matters: an exited process is dropped from `processes` but
		// stays in `records`. Check records first so we report
		// already-exited rather than not-found for shells we still know
		// about.
		const record = this.records.get(id);
		if (!record) return { outcome: "not-found" };
		if (record.status !== "running") return { outcome: "already-exited" };
		const child = this.processes.get(id);
		if (!child) return { outcome: "already-exited" };
		return new Promise<BackgroundShellKillResult>((resolve) => {
			let sigtermThrew = false;
			let sigkillThrew = false;
			const onExit = () => {
				clearTimeout(killTimer);
				if (sigtermThrew && sigkillThrew) {
					// Both threw but the process exited anyway — likely it was
					// already dying. Surface as signal-failed so the caller
					// can decide whether to retry differently.
					resolve({ outcome: "signal-failed" });
					return;
				}
				resolve({ outcome: "killed", signal: sigkillThrew ? "SIGTERM" : sigtermThrew ? "SIGKILL" : "SIGTERM" });
			};
			child.once("exit", onExit);
			try {
				child.kill("SIGTERM");
			} catch {
				sigtermThrew = true;
			}
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					sigkillThrew = true;
				}
			}, gracePeriodMs);
		});
	}

	/**
	 * SIGTERM all running shells. Used by terminal-restore on app exit
	 * so we don't leak children to the parent shell. Doesn't wait for
	 * graceful exits — the parent process is already going down.
	 */
	killAllSync(): void {
		for (const [_id, child] of this.processes) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Best effort during shutdown.
			}
		}
	}

	/** Subscribe to mutation events. Returns an unsubscribe function. */
	subscribe(listener: BackgroundShellListener): () => void {
		this.listeners.add(listener);
		listener(this.list());
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		const snapshot = this.list();
		for (const fn of this.listeners) fn(snapshot);
	}
}
