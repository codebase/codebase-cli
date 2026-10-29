import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** What a session file stores so a restart reuses the summary instead of re-summarizing. */
export interface CompactionSnapshot {
	count: number;
	/** Timestamp + role of the last covered message; identity doesn't survive a reload. */
	anchorTimestamp: number;
	anchorRole: AgentMessage["role"];
	prefix: AgentMessage[];
}

interface Covered {
	/** How many messages from the head of the transcript the summary replaces. */
	count: number;
	/** The last covered message, by identity — a rewind or session swap invalidates the memo. */
	anchor: AgentMessage;
	/** Summary + ack messages that stand in for the covered head. */
	prefix: AgentMessage[];
}

/**
 * Remembers the last compaction so later requests reuse its summary.
 *
 * transformContext runs before every model request but never rewrites the
 * agent's transcript, so without this each request re-summarized the same
 * history once it crossed the threshold — a "Compacting context" banner
 * (and a summarize call) on nearly every step.
 */
export class CompactionMemo {
	private covered: Covered | undefined;

	/** `messages` with the already-summarized head swapped for the stored summary. */
	apply(messages: AgentMessage[]): AgentMessage[] {
		const c = this.covered;
		if (!c) return messages;
		if (messages.length < c.count || messages[c.count - 1] !== c.anchor) {
			this.covered = undefined;
			return messages;
		}
		return [...c.prefix, ...messages.slice(c.count)];
	}

	/**
	 * Record a compaction of `view` (what `apply(messages)` returned) into
	 * `compacted`, where the first `collapsed` view messages were summarized.
	 */
	record(messages: AgentMessage[], view: AgentMessage[], compacted: AgentMessage[], collapsed: number): void {
		if (collapsed <= 0) return;
		const kept = view.length - collapsed;
		const prefix = compacted.slice(0, compacted.length - kept);
		// View indices past the old prefix line up with the original transcript.
		const old = view === messages ? undefined : this.covered;
		if (old && collapsed < old.prefix.length) return;
		const offset = old ? old.count - old.prefix.length : 0;
		const count = collapsed + offset;
		const anchor = messages[count - 1];
		if (!anchor) return;
		this.covered = { count, anchor, prefix };
	}

	snapshot(): CompactionSnapshot | undefined {
		const c = this.covered;
		if (!c) return undefined;
		return { count: c.count, anchorTimestamp: c.anchor.timestamp, anchorRole: c.anchor.role, prefix: c.prefix };
	}

	/** Re-adopt a saved snapshot when `messages` still has the covered head it describes. */
	restore(snapshot: CompactionSnapshot | undefined, messages: AgentMessage[]): void {
		if (!snapshot || snapshot.count <= 0 || !Array.isArray(snapshot.prefix)) return;
		const anchor = messages[snapshot.count - 1];
		if (!anchor || anchor.timestamp !== snapshot.anchorTimestamp || anchor.role !== snapshot.anchorRole) return;
		this.covered = { count: snapshot.count, anchor, prefix: snapshot.prefix };
	}
}
