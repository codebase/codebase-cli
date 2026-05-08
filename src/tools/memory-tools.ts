import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { MemoryRecord, MemoryType } from "../memory/types.js";
import type { ToolContext } from "./types.js";

const TypeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("feedback"),
	Type.Literal("project"),
	Type.Literal("reference"),
]);

// ─── save_memory ─────────────────────────────────────────────

const SaveParams = Type.Object({
	filename: Type.String({
		minLength: 1,
		maxLength: 80,
		description:
			"Memory filename, lowercase letters/digits/-/_ only, ending in .md (e.g. 'user_role.md'). " +
			"Use a name that describes the memory's subject.",
	}),
	name: Type.String({
		minLength: 1,
		maxLength: 100,
		description: "Short human-readable title (a few words).",
	}),
	description: Type.String({
		minLength: 1,
		maxLength: 200,
		description: "One-line description of when this memory applies. Used in MEMORY.md to decide relevance.",
	}),
	type: TypeSchema,
	body: Type.String({
		description: "Full memory content. Markdown allowed. Be specific about WHY this matters for future sessions.",
	}),
});

export type SaveMemoryParams = Static<typeof SaveParams>;

export interface SaveMemoryDetails {
	filename: string;
	type: MemoryType;
	bytes: number;
}

const SAVE_DESCRIPTION = `Persist a memory across sessions. Memory entries are written to ~/.codebase/projects/<projectHash>/memory/ and MEMORY.md is updated with a one-line index entry.

The 4-type taxonomy:
- user: stable facts about the user (role, preferences, expertise) that should shape how you collaborate.
- feedback: rules the user gave you ("don't do X", "always do Y"). Include the WHY so you can judge edge cases.
- project: context about the work itself — initiatives, blockers, decisions. These rot fast; convert relative dates to absolute.
- reference: pointers to external systems (Linear projects, dashboards, Slack channels).

Don't save derivable info (file paths, commit history, code conventions). Don't save ephemeral conversation state. Do save what was non-obvious or surprising.`;

export function createSaveMemory(ctx: ToolContext): AgentTool<typeof SaveParams, SaveMemoryDetails> {
	return {
		name: "save_memory",
		label: "Save memory",
		description: SAVE_DESCRIPTION,
		parameters: SaveParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const record = ctx.memory.save({
				filename: params.filename,
				name: params.name,
				description: params.description,
				type: params.type,
				body: params.body,
			});
			updateIndex(ctx);
			return {
				content: [{ type: "text", text: `Saved memory ${record.filename} (${record.type}).` }],
				details: { filename: record.filename, type: record.type, bytes: Buffer.byteLength(record.body, "utf8") },
			};
		},
	};
}

// ─── read_memory ─────────────────────────────────────────────

const ReadParams = Type.Object({
	filename: Type.Optional(Type.String({ description: "Read a specific memory file (e.g. 'user_role.md')." })),
	type: Type.Optional(
		Type.Union([TypeSchema], {
			description: "List only memories of this type. Mutually exclusive with filename.",
		}),
	),
});

export type ReadMemoryParams = Static<typeof ReadParams>;

export interface ReadMemoryDetails {
	mode: "single" | "list" | "index";
	records?: MemoryRecord[];
	record?: MemoryRecord;
	index?: string;
}

const READ_DESCRIPTION = `Read project memory.
- With filename: returns that single memory's frontmatter + body.
- With type: returns the list of memories of that type (frontmatter + body).
- With neither: returns the MEMORY.md index for orientation. Use this first if you want to know what's there.`;

export function createReadMemory(ctx: ToolContext): AgentTool<typeof ReadParams, ReadMemoryDetails> {
	return {
		name: "read_memory",
		label: "Read memory",
		description: READ_DESCRIPTION,
		parameters: ReadParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			if (params.filename) {
				const record = ctx.memory.read(params.filename);
				if (!record) {
					throw new Error(`memory ${params.filename} not found`);
				}
				return {
					content: [{ type: "text", text: formatRecord(record) }],
					details: { mode: "single", record },
				};
			}

			if (params.type) {
				const records = ctx.memory.list(params.type);
				const text =
					records.length === 0
						? `(no memories of type ${params.type})`
						: records.map(formatRecord).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text }],
					details: { mode: "list", records },
				};
			}

			const index = ctx.memory.index();
			return {
				content: [{ type: "text", text: index || "(MEMORY.md is empty — no memories saved yet)" }],
				details: { mode: "index", index },
			};
		},
	};
}

function formatRecord(record: MemoryRecord): string {
	return [`# ${record.name}  (${record.type})`, `> ${record.description}`, "", record.body.trim()].join("\n");
}

// ─── shared: update MEMORY.md after a save ───────────────────

function updateIndex(ctx: ToolContext): void {
	const records = ctx.memory.list();
	if (records.length === 0) {
		ctx.memory.writeIndex("");
		return;
	}
	const lines = records.map((r) => `- [${r.name}](${r.filename}) — ${r.description}`);
	ctx.memory.writeIndex(`${lines.join("\n")}\n`);
}

// ─── factory bundle ──────────────────────────────────────────

export function createMemoryTools(ctx: ToolContext): AgentTool<TSchema>[] {
	return [createSaveMemory(ctx), createReadMemory(ctx)];
}
