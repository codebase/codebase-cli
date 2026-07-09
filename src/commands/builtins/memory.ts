import { rebuildMemoryIndex } from "../../memory/index-file.js";
import { MEMORY_TYPES, type MemoryRecord, type MemoryType } from "../../memory/types.js";
import type { Command } from "../types.js";

// ─── memory + context ─────────────────────────────────────────────────

export const memory: Command = {
	name: "memory",
	description: "Inspect or delete saved project memories. /memory [list|show|forget].",
	mutates: true,
	handler: (args, ctx) => {
		const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
		if (!sub) {
			const index = ctx.bundle.memory.index();
			if (!index.trim()) {
				ctx.emit("no memories saved yet. The agent can write them via the save_memory tool or you can type #note.");
				return { handled: true };
			}
			ctx.emit(index);
			return { handled: true };
		}

		const action = sub.toLowerCase();
		if (action === "list") {
			const type = rest[0] ? parseType(rest[0]) : undefined;
			if (rest[0] && !type) {
				ctx.emit(`Usage: /memory list [${MEMORY_TYPES.join("|")}]`);
				return { handled: true };
			}
			const records = ctx.bundle.memory.list(type);
			if (records.length === 0) {
				ctx.emit(type ? `no ${type} memories saved yet.` : "no memories saved yet.");
				return { handled: true };
			}
			ctx.emit(records.map(formatMemoryLine).join("\n"));
			return { handled: true };
		}

		if (action === "show") {
			const filename = rest[0];
			if (!filename) {
				ctx.emit("Usage: /memory show <filename>");
				return { handled: true };
			}
			const record = ctx.bundle.memory.read(filename);
			ctx.emit(record ? formatMemoryRecord(record) : `memory not found: ${filename}`);
			return { handled: true };
		}

		if (action === "forget" || action === "delete" || action === "remove" || action === "rm") {
			const filename = rest[0];
			if (!filename) {
				ctx.emit("Usage: /memory forget <filename>");
				return { handled: true };
			}
			const removed = ctx.bundle.memory.delete(filename);
			if (removed) rebuildMemoryIndex(ctx.bundle.memory);
			ctx.emit(removed ? `forgot memory: ${filename}` : `memory not found: ${filename}`);
			return { handled: true };
		}

		if (action === "help") {
			ctx.emit(
				[
					"Usage: /memory [list|show|forget]",
					"  /memory                 show MEMORY.md index",
					"  /memory list [type]     list memory files with provenance",
					"  /memory show <file.md>  show one memory body + metadata",
					"  /memory forget <file.md> delete one memory and rebuild the index",
				].join("\n"),
			);
			return { handled: true };
		}

		ctx.emit("Usage: /memory [list|show|forget]");
		return { handled: true };
	},
};

function parseType(value: string): MemoryType | undefined {
	const normalized = value.trim().toLowerCase();
	return MEMORY_TYPES.find((type) => type === normalized);
}

function formatMemoryLine(record: MemoryRecord): string {
	return [
		`${record.filename} [${record.type}] ${record.name}`,
		`  source: ${record.source}; session: ${record.sourceSessionId ?? "unknown"}; updated: ${formatDate(record.updatedAt)}; last used: ${formatOptionalDate(record.lastUsedAt)}; retrievals: ${record.retrievalCount}`,
		`  ${record.description}`,
	].join("\n");
}

function formatMemoryRecord(record: MemoryRecord): string {
	return [
		`# ${record.name} (${record.type})`,
		`file: ${record.filename}`,
		`description: ${record.description}`,
		`source: ${record.source}`,
		`source session: ${record.sourceSessionId ?? "unknown"}`,
		`created: ${formatDate(record.createdAt)}`,
		`updated: ${formatDate(record.updatedAt)}`,
		`last used: ${formatOptionalDate(record.lastUsedAt)}`,
		`retrievals: ${record.retrievalCount}`,
		"",
		record.body.trim(),
	].join("\n");
}

function formatDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function formatOptionalDate(ms?: number): string {
	return ms ? formatDate(ms) : "never";
}
