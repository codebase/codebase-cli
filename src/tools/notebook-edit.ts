import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { atomicWrite, resolveInsideCwd, validateForOverwrite } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.String({
		description: "Path to a .ipynb file. Must be read with read_file first.",
	}),
	cell_index: Type.Integer({
		minimum: 0,
		description:
			"0-based cell index. For insert, this is the position where the new cell appears (subsequent cells shift down).",
	}),
	operation: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")], {
		description: "insert: add a new cell. update: replace source/type of existing cell. delete: remove the cell.",
	}),
	cell_type: Type.Optional(
		Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
			description: "Required for insert. Optional for update (omit to keep existing type).",
		}),
	),
	source: Type.Optional(
		Type.String({
			description: "Cell source. Required for insert and update. Ignored for delete.",
		}),
	),
});

export type NotebookEditParams = Static<typeof Params>;

export interface NotebookEditDetails {
	path: string;
	operation: "insert" | "update" | "delete";
	cellIndex: number;
	cellCount: number;
	bytes: number;
}

interface NotebookCell {
	cell_type: "code" | "markdown" | string;
	source: string | string[];
	metadata?: Record<string, unknown>;
	outputs?: unknown[];
	execution_count?: number | null;
	[key: string]: unknown;
}

interface Notebook {
	cells: NotebookCell[];
	metadata?: Record<string, unknown>;
	nbformat?: number;
	nbformat_minor?: number;
	[key: string]: unknown;
}

const DESCRIPTION = `Insert, update, or delete a cell in a Jupyter .ipynb notebook.

Hard rules (same as edit_file):
- Notebook must be read with read_file first.
- If the file changed on disk between read and edit, the operation is rejected with "unexpectedly modified".
- BOM and line endings are preserved.

Operation semantics:
- insert: cell_type and source required. New cell goes at cell_index; existing cells shift down.
- update: source required; cell_type optional (omit to preserve type). cell_index must point at an existing cell.
- delete: cell_index must point at an existing cell. cell_type and source ignored.

Source is stored as a JSON string. Code cells get empty outputs and null execution_count; markdown cells get neither.`;

export function createNotebookEdit(ctx: ToolContext): AgentTool<typeof Params, NotebookEditDetails> {
	return {
		name: "notebook_edit",
		label: "Notebook edit",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_id, params) => {
			if (!params.path.endsWith(".ipynb")) {
				throw new Error(`notebook_edit only operates on .ipynb files; got ${params.path}`);
			}

			const absPath = resolveInsideCwd(ctx.cwd, params.path);
			const snap = validateForOverwrite(absPath, ctx.fileStateCache);

			let notebook: Notebook;
			try {
				notebook = JSON.parse(snap.content) as Notebook;
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${params.path} is not valid JSON: ${reason}`);
			}
			if (!Array.isArray(notebook.cells)) {
				throw new Error(`${params.path} does not look like a notebook (no cells array).`);
			}

			applyOperation(notebook, params);

			const next = `${JSON.stringify(notebook, null, 1)}\n`;
			const mode = statSync(absPath).mode & 0o777;
			const { mtimeMs, size } = atomicWrite(absPath, next, {
				hasBOM: snap.hasBOM,
				eol: snap.eol,
				mode,
			});

			ctx.fileStateCache.record({
				path: absPath,
				content: next,
				mtimeMs,
				size,
				hasBOM: snap.hasBOM,
				eol: snap.eol,
				isPartialView: false,
				storedAt: Date.now(),
			});

			return {
				content: [
					{
						type: "text",
						text: `${params.operation} cell ${params.cell_index} in ${params.path} (${notebook.cells.length} cells total)`,
					},
				],
				details: {
					path: absPath,
					operation: params.operation,
					cellIndex: params.cell_index,
					cellCount: notebook.cells.length,
					bytes: size,
				},
			};
		},
	};
}

function applyOperation(notebook: Notebook, params: NotebookEditParams): void {
	const cells = notebook.cells;
	const idx = params.cell_index;

	if (params.operation === "insert") {
		if (!params.cell_type) throw new Error("insert requires cell_type.");
		if (params.source === undefined) throw new Error("insert requires source.");
		if (idx < 0 || idx > cells.length) {
			throw new Error(`insert index ${idx} is out of range (0..${cells.length}).`);
		}
		cells.splice(idx, 0, makeCell(params.cell_type, params.source));
		return;
	}

	if (params.operation === "delete") {
		assertExists(cells, idx);
		cells.splice(idx, 1);
		return;
	}

	// update
	assertExists(cells, idx);
	if (params.source === undefined) throw new Error("update requires source.");
	const existing = cells[idx];
	const nextType = params.cell_type ?? (existing.cell_type === "code" ? "code" : "markdown");
	const next: NotebookCell = {
		...existing,
		cell_type: nextType,
		source: params.source,
	};
	if (nextType === "code") {
		next.outputs = existing.outputs ?? [];
		next.execution_count = existing.execution_count ?? null;
	} else {
		// Markdown cells don't carry outputs or execution_count.
		delete next.outputs;
		delete next.execution_count;
	}
	cells[idx] = next;
}

function assertExists(cells: NotebookCell[], idx: number): void {
	if (idx < 0 || idx >= cells.length) {
		throw new Error(`cell index ${idx} is out of range (0..${cells.length - 1}).`);
	}
}

function makeCell(type: "code" | "markdown", source: string): NotebookCell {
	if (type === "code") {
		return { cell_type: "code", source, metadata: {}, outputs: [], execution_count: null };
	}
	return { cell_type: "markdown", source, metadata: {} };
}
