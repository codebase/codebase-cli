import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { applyEdit, atomicWrite, resolveInsideCwd, validateForOverwrite } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.String({
		description: "File path (absolute or relative to the project root). Must be read with read_file first.",
	}),
	old_string: Type.String({
		description: "Exact text to replace. Must match including indentation, trailing spaces, and newline style.",
	}),
	new_string: Type.String({
		description: "Replacement text. Will be written with the file's existing line ending and BOM preserved.",
	}),
	replace_all: Type.Optional(
		Type.Boolean({
			description: "Replace every occurrence. Default false (errors on multiple matches).",
		}),
	),
});

export type EditFileParams = Static<typeof Params>;

export interface EditFileDetails {
	path: string;
	replacements: number;
	bytes: number;
}

const DESCRIPTION = `Replace exact text in a file. Single-match by default; set replace_all to substitute every occurrence.

Hard rules:
- The file must have been read with read_file in the current turn. Otherwise this errors with "not read first".
- If the file changed on disk between the last read and this edit, this errors with "file unexpectedly modified" — read it again.
- old_string must match exactly: indentation, trailing whitespace, and the file's line endings (LF or CRLF).
- BOM and line endings are preserved on write — Windows-authored files stay Windows-formatted.
- File permissions (mode) are preserved.

Errors are deliberately specific so you can self-correct:
- "not read first" → call read_file first.
- "unexpectedly modified" → read_file again before retrying.
- "old_string not found" → the file may have changed; re-read.
- "appears N times" → quote more surrounding context, or use replace_all.

To create a new file, use write_file. To append, read then edit with the new content appended.`;

export function createEditFile(ctx: ToolContext): AgentTool<typeof Params, EditFileDetails> {
	return {
		name: "edit_file",
		label: "Edit",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const absPath = resolveInsideCwd(ctx.cwd, params.path);
			const snap = validateForOverwrite(absPath, ctx.fileStateCache);

			const { content: nextContent, replacements } = applyEdit(snap.content, {
				oldString: params.old_string,
				newString: params.new_string,
				replaceAll: params.replace_all ?? false,
				path: params.path,
			});

			const mode = statSync(absPath).mode & 0o777;
			const { mtimeMs, size } = atomicWrite(absPath, nextContent, {
				hasBOM: snap.hasBOM,
				eol: snap.eol,
				mode,
			});

			ctx.fileStateCache.record({
				path: absPath,
				content: nextContent,
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
						text:
							replacements === 1
								? `Edited ${params.path}.`
								: `Edited ${params.path} (${replacements} replacements).`,
					},
				],
				details: { path: absPath, replacements, bytes: size },
			};
		},
	};
}
