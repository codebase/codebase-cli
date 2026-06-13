/**
 * Registry of the transcript's copy boxes for keyboard-driven copy mode.
 *
 * Each CopyBox registers its label + exact clean text under a stable key
 * (so re-renders don't duplicate it). Ctrl-O opens a picker over the most
 * recent entries; selecting one pushes its text to the clipboard via OSC
 * 52 — clean, unwrapped, works over SSH, and never touches the mouse, so
 * native select + scroll stay intact.
 */

export interface CopyEntry {
	id: number;
	label: string;
	text: string;
}

export class CopyRegistry {
	private readonly entries = new Map<number, CopyEntry>();
	private readonly keyToId = new Map<string, number>();
	private nextId = 1;

	/** Record (or refresh) a box's copyable text under a stable dedupe key. */
	register(key: string, label: string, text: string): number {
		let id = this.keyToId.get(key);
		if (id === undefined) {
			id = this.nextId++;
			this.keyToId.set(key, id);
		}
		this.entries.set(id, { id, label, text });
		return id;
	}

	get(id: number): CopyEntry | undefined {
		return this.entries.get(id);
	}

	/** All entries in registration order (oldest first). */
	list(): CopyEntry[] {
		return [...this.entries.values()].sort((a, b) => a.id - b.id);
	}
}
