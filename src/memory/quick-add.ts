import type { MemoryStore } from "./store.js";
import type { MemoryRecord, MemoryType } from "./types.js";

/**
 * Quick-add a memory from a `#`-prefixed input line. The user types
 * `# always run the linter before committing` and it lands as a memory
 * file without spending an agent turn. An optional `#<type>:` prefix
 * picks the bucket (`#feedback: …`, `#project: …`); default is `user`.
 */

const TYPE_PREFIX = /^#\s*(user|feedback|project|reference)\s*:\s*/i;

export function quickAddMemory(store: MemoryStore, raw: string): MemoryRecord {
	const body = raw.replace(/^#/, "").trim();
	let type: MemoryType = "user";
	let text = body;
	const typed = raw.match(TYPE_PREFIX);
	if (typed) {
		type = typed[1].toLowerCase() as MemoryType;
		text = raw.slice(typed[0].length).trim();
	}
	const name = text.length > 60 ? `${text.slice(0, 57)}…` : text;
	const slug =
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "note";
	const filename = `${slug}-${Date.now().toString(36)}.md`;
	return store.save({ filename, name, description: name, type, body: text });
}
