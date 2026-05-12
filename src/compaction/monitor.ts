/**
 * Live status of in-flight compaction. The agent's transformContext hook
 * runs synchronously on the critical path: when it triggers, the user
 * sees a multi-second freeze with no visual signal — looks like a hang.
 *
 * CompactionMonitor is the bridge between the hook and the TUI: the hook
 * calls `start()` before the glue summarize call, `end()` after. The TUI
 * subscribes and renders a "Compacting…" banner for the duration. Same
 * pubsub pattern PermissionStore and UserQueryStore use.
 */

export interface CompactionState {
	active: boolean;
	/** Wall-clock ms when start() was called; used for an elapsed-seconds label. */
	startedAt: number | null;
	/** How many messages were in the transcript when compaction kicked off. */
	messageCount: number;
}

export type CompactionListener = (state: CompactionState) => void;

export class CompactionMonitor {
	private state: CompactionState = { active: false, startedAt: null, messageCount: 0 };
	private readonly listeners = new Set<CompactionListener>();

	start(messageCount: number): void {
		this.state = { active: true, startedAt: Date.now(), messageCount };
		this.notify();
	}

	end(): void {
		this.state = { active: false, startedAt: null, messageCount: 0 };
		this.notify();
	}

	current(): CompactionState {
		return this.state;
	}

	subscribe(listener: CompactionListener): () => void {
		this.listeners.add(listener);
		listener(this.current());
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		const snapshot = this.current();
		for (const listener of this.listeners) listener(snapshot);
	}
}
