import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { atomicWrite, detectEol, pathExists, resolveInsideCwd, validateForOverwrite } from "./file-ops.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.String({
		description:
			"File path (absolute or relative to the project root). Parent directories are created automatically.",
	}),
	content: Type.String({
		description:
			"File contents. Line endings in the content are normalized to the file's existing style on overwrite.",
	}),
});

export type WriteFileParams = Static<typeof Params>;

export interface WriteFileDetails {
	path: string;
	created: boolean;
	bytes: number;
}

const DESCRIPTION = `Create a new file or overwrite an existing one.

Hard rules:
- To OVERWRITE an existing file, you must read it with read_file first in the current turn. Otherwise this errors with "not read first".
- If the file changed on disk between the last read and this write, this errors with "file unexpectedly modified" — read it again.
- To CREATE a new file, no prior read is required. Parent directories are created.
- On overwrite, BOM and line endings are preserved from the original file. On create, the encoding follows the supplied content (LF inferred from content; BOM inferred from a leading 0xEF 0xBB 0xBF in the supplied bytes).
- File permissions are preserved on overwrite; new files default to 0644.

Use edit_file when you only need to change part of a file — it's safer because it won't accidentally truncate context the model didn't fully read.`;

export function createWriteFile(ctx: ToolContext): AgentTool<typeof Params, WriteFileDetails> {
	return {
		name: "write_file",
		label: "Write",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const absPath = resolveInsideCwd(ctx.cwd, params.path);
			const exists = pathExists(absPath);

			let hasBOM = false;
			let eol: "\n" | "\r\n" | "" = detectEol(params.content);
			let mode = 0o644;
			let encoding: "utf8" | "utf16le" | "utf16be" = "utf8";

			if (exists) {
				const snap = validateForOverwrite(absPath, ctx.fileStateCache);
				hasBOM = snap.hasBOM;
				eol = snap.eol;
				encoding = snap.encoding ?? "utf8";
				mode = statSync(absPath).mode & 0o777;
			} else {
				// Bare-bytes hint: a new file's content may already start with BOM characters.
				if (params.content.charCodeAt(0) === 0xfeff) {
					hasBOM = true;
				}
			}

			const written = atomicWrite(absPath, params.content, { hasBOM, eol, encoding, mode });

			ctx.fileStateCache.record({
				path: absPath,
				content: params.content.charCodeAt(0) === 0xfeff ? params.content.slice(1) : params.content,
				mtimeMs: written.mtimeMs,
				size: written.size,
				hasBOM,
				encoding,
				eol,
				isPartialView: false,
				storedAt: Date.now(),
			});

			return {
				content: [
					{
						type: "text",
						text: exists ? `Overwrote ${params.path} (${written.size} bytes).` : `Created ${params.path}.`,
					},
				],
				details: { path: absPath, created: !exists, bytes: written.size },
			};
		},
	};
}
