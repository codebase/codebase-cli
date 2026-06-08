import type { BackgroundShellStore } from "./background-shell-store.js";

/**
 * Per-monitor configuration. Each monitor watches one background shell
 * for matching lines and emits a "match" event the App layer steers
 * into the agent as a system-reminder.
 *
 * Matching is line-by-line: we buffer incoming chunks until we see a
 * newline, then test each completed line against `regex`. Partial
 * tail (no trailing newline yet) carries over to the next chunk.
 */
export interface MonitorConfig {
	id: string;
	/** Background-shell id this monitor watches. */
	taskId: string;
	/** Regex applied per line. undefined = match every line. */
	regex?: RegExp;
	/** Stop emitting after this many matches (default: unbounded). */
	maxMatches?: number;
	/** Free-form note for the agent on each emit ("watching for ERROR in nginx log"). */
	note?: string;
}

export interface MonitorMatchEvent {
	monitorId: string;
	taskId: string;
	line: string;
	note?: string;
	matchedAt: number;
}

export type MonitorListener = (event: MonitorMatchEvent) => void;

/**
 * Tracks active line-monitors over background shells. The `monitor`
 * tool registers here, the App subscribes here and turns events into
 * agent.steer() system-reminders so the model sees them without
 * polling shell_output.
 *
 * Lifecycle: a monitor is auto-removed when its target shell exits
 * (no more output → no point keeping the registration around).
 */
export class MonitorStore {
	private readonly bgShells: BackgroundShellStore;
	private readonly monitors = new Map<string, MonitorConfig>();
	private readonly perMonitorUnsub = new Map<string, () => void>();
	private readonly perMonitorBuffer = new Map<string, string>();
	private readonly perMonitorCount = new Map<string, number>();
	private readonly listeners = new Set<MonitorListener>();
	private nextId = 1;

	constructor(bgShells: BackgroundShellStore) {
		this.bgShells = bgShells;
		// Auto-cleanup: when a watched shell exits, drop any monitors
		// pointing at it. The BackgroundShellStore already releases its
		// own output-listener set on exit, so we just need to clear our
		// registry side.
		this.bgShells.subscribe((shells) => {
			for (const shell of shells) {
				if (shell.status === "running") continue;
				for (const [monitorId, cfg] of this.monitors) {
					if (cfg.taskId === shell.id) this.remove(monitorId);
				}
			}
		});
	}

	register(cfg: Omit<MonitorConfig, "id">): MonitorConfig {
		const id = `mon-${this.nextId++}`;
		const full: MonitorConfig = { ...cfg, id };
		this.monitors.set(id, full);
		this.perMonitorBuffer.set(id, "");
		this.perMonitorCount.set(id, 0);

		const unsub = this.bgShells.subscribeOutput(cfg.taskId, (chunk) => {
			this.consumeChunk(id, chunk);
		});
		this.perMonitorUnsub.set(id, unsub);
		return { ...full };
	}

	remove(id: string): boolean {
		const had = this.monitors.delete(id);
		const unsub = this.perMonitorUnsub.get(id);
		if (unsub) {
			try {
				unsub();
			} catch {
				// best effort
			}
			this.perMonitorUnsub.delete(id);
		}
		this.perMonitorBuffer.delete(id);
		this.perMonitorCount.delete(id);
		return had;
	}

	list(): readonly MonitorConfig[] {
		return Array.from(this.monitors.values()).map((m) => ({ ...m }));
	}

	get(id: string): MonitorConfig | undefined {
		const m = this.monitors.get(id);
		return m ? { ...m } : undefined;
	}

	/** Subscribe to match events. App calls agent.steer() on each. */
	onMatch(listener: MonitorListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private consumeChunk(monitorId: string, chunk: string): void {
		const cfg = this.monitors.get(monitorId);
		if (!cfg) return;
		// Carry partial-line tail across chunks so a regex that ends with
		// `$` actually matches end-of-line, not end-of-chunk.
		const buffered = (this.perMonitorBuffer.get(monitorId) ?? "") + chunk;
		const newlineIdx = buffered.lastIndexOf("\n");
		if (newlineIdx === -1) {
			this.perMonitorBuffer.set(monitorId, buffered);
			return;
		}
		const complete = buffered.slice(0, newlineIdx);
		const tail = buffered.slice(newlineIdx + 1);
		this.perMonitorBuffer.set(monitorId, tail);

		for (const line of complete.split("\n")) {
			if (line.length === 0) continue;
			if (cfg.regex && !cfg.regex.test(line)) continue;
			const count = (this.perMonitorCount.get(monitorId) ?? 0) + 1;
			this.perMonitorCount.set(monitorId, count);
			this.emit({
				monitorId,
				taskId: cfg.taskId,
				line,
				note: cfg.note,
				matchedAt: Date.now(),
			});
			if (cfg.maxMatches !== undefined && count >= cfg.maxMatches) {
				this.remove(monitorId);
				return;
			}
		}
	}

	private emit(event: MonitorMatchEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(event);
			} catch {
				// best effort
			}
		}
	}
}
