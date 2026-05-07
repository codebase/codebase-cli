import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { applyEdit, atomicWrite, resolveInsideCwd, validateForOverwrite } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.String({
		description: "File path (absolute or relative to the project root). Must be read with read_file first.",
	}),
	edits: Type.Array(
		Type.Object({
			old_string: Type.String({
				description: "Exact text to replace. Must match including indentation and line endings.",
			}),
			new_string: Type.String({
				description: "Replacement text.",
			}),
			replace_all: Type.Optional(
				Type.Boolean({
					description: "Replace every occurrence within this edit. Default false.",
				}),
			),
		}),
		{ minItems: 1, maxItems: 100, description: "Edits to apply in order." },
	),
});

export type MultiEditParams = Static<typeof Params>;

export interface MultiEditDetails {
	path: string;
	edits: number;
	replacements: number;
	bytes: number;
}

const DESCRIPTION = `Apply multiple edits to a single file atomically.

Hard rules:
- The file must have been read with read_file in the current turn (same as edit_file).
- If the file changed on disk between the last read and this call, the entire batch is rejected.
- Edits apply in order to a running in-memory copy. Edit N+1 sees the result of edit N — useful for cascading rename-style changes.
- If any edit fails (no match, ambiguous match, identical strings), the whole batch is aborted and nothing is written.
- BOM, line endings, and file mode are preserved exactly as edit_file.

Use this when you have several related changes in the same file (e.g. rename a symbol everywhere). For changes across many files, call edit_file separately per file — multi_edit is single-file by design.`;

export function createMultiEdit(ctx: ToolContext): AgentTool<typeof Params, MultiEditDetails> {
	return {
		name: "multi_edit",
		label: "Multi-edit",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const absPath = resolveInsideCwd(ctx.cwd, params.path);
			const snap = validateForOverwrite(absPath, ctx.fileStateCache);

			let content = snap.content;
			let totalReplacements = 0;
			for (let i = 0; i < params.edits.length; i++) {
				const edit = params.edits[i];
				try {
					const next = applyEdit(content, {
						oldString: edit.old_string,
						newString: edit.new_string,
						replaceAll: edit.replace_all ?? false,
						path: params.path,
					});
					content = next.content;
					totalReplacements += next.replacements;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					throw new Error(`edit #${i + 1} failed: ${reason}`);
				}
			}

			const mode = statSync(absPath).mode & 0o777;
			const { mtimeMs, size } = atomicWrite(absPath, content, {
				hasBOM: snap.hasBOM,
				eol: snap.eol,
				mode,
			});

			ctx.fileStateCache.record({
				path: absPath,
				content,
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
						text: `Applied ${params.edits.length} edit${params.edits.length === 1 ? "" : "s"} to ${
							params.path
						} (${totalReplacements} replacement${totalReplacements === 1 ? "" : "s"}).`,
					},
				],
				details: { path: absPath, edits: params.edits.length, replacements: totalReplacements, bytes: size },
			};
		},
	};
}
