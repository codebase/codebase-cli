import type { MemoryStore } from "./store.js";

/**
 * Rebuild MEMORY.md from the per-type files on disk. The index is what
 * gets injected into the system prompt, so every write path (save_memory
 * tool, `#` quick-add, auto-extraction) must call this or the new memory
 * stays invisible to the agent.
 */
export function rebuildMemoryIndex(store: MemoryStore): void {
	const records = store.list();
	if (records.length === 0) {
		store.writeIndex("");
		return;
	}
	const lines = records.map((r) => `- [${r.name}](${r.filename}) — ${r.description}`);
	store.writeIndex(`${lines.join("\n")}\n`);
}
