import { Container, Text } from "@earendil-works/pi-tui";
import type { CompactionMonitor, CompactionState } from "../compaction/monitor.js";
import { ansi } from "./theme.js";

/**
 * Sticky banner shown while pi-agent-core is summarising older turns
 * into a compaction checkpoint. Subscribes to the bundle's
 * CompactionMonitor and shows/hides itself based on `active`, with a
 * 1-second timer that refreshes the elapsed-seconds suffix so the user
 * sees forward motion on long compactions.
 */
export class CompactionBanner extends Container {
	private readonly line: Text;
	private unsubscribe: () => void;
	private timer: NodeJS.Timeout | undefined;
	private state: CompactionState = { active: false, startedAt: null, messageCount: 0 };
	/** Called after every state change so the host can schedule a redraw. */
	private requestRender: () => void;

	constructor(monitor: CompactionMonitor, requestRender: () => void = () => undefined) {
		super();
		this.line = new Text("", 1, 0);
		this.requestRender = requestRender;
		this.unsubscribe = monitor.subscribe((s) => this.applyState(s));
	}

	/** Re-bind to a fresh CompactionMonitor after a model swap rebuilds the bundle. */
	rebind(monitor: CompactionMonitor): void {
		this.unsubscribe();
		this.unsubscribe = monitor.subscribe((s) => this.applyState(s));
	}

	private applyState(state: CompactionState): void {
		this.state = state;
		this.stopTimer();
		const children = (this as unknown as { children: unknown[] }).children;
		if (!state.active) {
			if (Array.isArray(children)) children.length = 0;
			this.invalidate();
			this.requestRender();
			return;
		}
		if (Array.isArray(children) && children.length === 0) {
			this.addChild(this.line);
		}
		this.refresh();
		// Tick elapsed-seconds while compaction is in progress so the user
		// has a clear "still working" signal on multi-second runs.
		this.timer = setInterval(() => this.refresh(), 1000);
	}

	private refresh(): void {
		const elapsed = this.state.startedAt ? Math.floor((Date.now() - this.state.startedAt) / 1000) : 0;
		const suffix = elapsed > 0 ? ` · ${elapsed}s` : "";
		this.line.setText(ansi.yellow(`⟳ Compacting context (${this.state.messageCount} messages${suffix})…`));
		this.line.invalidate();
		this.requestRender();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.stopTimer();
		this.unsubscribe();
	}
}
