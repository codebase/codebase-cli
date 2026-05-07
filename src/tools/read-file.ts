import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { BinaryFileError, FileTooLargeError, PathOutsideCwdError } from "./errors.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.String({
		description: "File path (absolute or relative to the project root).",
	}),
	offset: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "1-based starting line. Defaults to 1.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description: "Max lines to return. Defaults to 2000.",
		}),
	),
});

export type ReadFileParams = Static<typeof Params>;

export interface ReadFileDetails {
	path: string;
	bytes: number;
	totalLines: number;
	returnedLines: number;
	hasBOM: boolean;
	eol: "\n" | "\r\n" | "";
	isPartialView: boolean;
	isImage: boolean;
}

const DEFAULT_LIMIT = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8192;
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const DESCRIPTION = `Read the contents of a text or image file.

Arguments:
- path: file path. Absolute or relative to the project root. Symlinks are followed but resolved targets must remain inside the project root.
- offset (optional): 1-based first line to return. Default 1.
- limit (optional): max lines to return. Default 2000, max 2000.

Behavior:
- Text files: returned line-numbered (six-column gutter, tab, content), suitable for the model to quote back into edit_file.
- Image files (.png, .jpg, .jpeg, .gif, .webp, .bmp): returned as a vision payload — works only with image-capable models.
- Files > 5 MB are rejected; use shell head/tail/sed for huge files.
- Binary text files are rejected.
- Reading a file records a snapshot for read-before-edit. If the file changes on disk before edit_file fires, the edit is rejected with a clear error.`;

export function createReadFile(ctx: ToolContext): AgentTool<typeof Params, ReadFileDetails> {
	return {
		name: "read_file",
		label: "Read",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const absPath = resolveInsideCwd(ctx.cwd, params.path);

			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(absPath);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`Cannot read ${params.path}: ${reason}`);
			}
			if (stat.isDirectory()) {
				throw new Error(`${params.path} is a directory; use list_files to enumerate its contents.`);
			}

			// Image branch
			const ext = extname(absPath).toLowerCase();
			const mime = IMAGE_MIME[ext];
			if (mime) {
				if (stat.size > MAX_FILE_BYTES) {
					throw new FileTooLargeError(params.path, stat.size, MAX_FILE_BYTES);
				}
				const data = readFileSync(absPath).toString("base64");
				return {
					content: [{ type: "image", data, mimeType: mime }],
					details: {
						path: absPath,
						bytes: stat.size,
						totalLines: 0,
						returnedLines: 0,
						hasBOM: false,
						eol: "",
						isPartialView: false,
						isImage: true,
					},
				};
			}

			if (stat.size > MAX_FILE_BYTES) {
				throw new FileTooLargeError(params.path, stat.size, MAX_FILE_BYTES);
			}

			const raw = readFileSync(absPath);
			if (isLikelyBinary(raw)) {
				throw new BinaryFileError(params.path);
			}

			const { content, hasBOM } = stripBOM(raw);
			const eol = detectEol(content);
			const allLines = content.split(/\r\n|\n/);
			// Trailing-newline files split into an extra empty trailing element; trim it for line counts.
			const totalLines =
				allLines.length > 0 && allLines[allLines.length - 1] === "" ? allLines.length - 1 : allLines.length;

			const offset = params.offset ?? 1;
			const limit = params.limit ?? DEFAULT_LIMIT;
			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(startIdx + limit, totalLines);
			const isPartialView = startIdx > 0 || endIdx < totalLines;

			const slice = allLines.slice(startIdx, endIdx);
			const formatted = slice.map((line, i) => `${pad6(startIdx + i + 1)}\t${line}`).join("\n");
			const tail = isPartialView ? `\n... (showing lines ${startIdx + 1}-${endIdx} of ${totalLines})` : "";

			ctx.fileStateCache.record({
				path: absPath,
				content,
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				hasBOM,
				eol,
				isPartialView,
				range: isPartialView ? { startLine: startIdx + 1, endLine: endIdx } : undefined,
				storedAt: Date.now(),
			});

			return {
				content: [{ type: "text", text: formatted + tail }],
				details: {
					path: absPath,
					bytes: stat.size,
					totalLines,
					returnedLines: slice.length,
					hasBOM,
					eol,
					isPartialView,
					isImage: false,
				},
			};
		},
	};
}

function pad6(n: number): string {
	return String(n).padStart(6, " ");
}

function resolveInsideCwd(cwd: string, requested: string): string {
	const absCwd = resolve(cwd);
	const candidate = isAbsolute(requested) ? resolve(requested) : resolve(absCwd, requested);
	if (candidate !== absCwd && !candidate.startsWith(absCwd + sep)) {
		throw new PathOutsideCwdError(requested);
	}
	return candidate;
}

function stripBOM(buf: Buffer): { content: string; hasBOM: boolean } {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return { content: buf.subarray(3).toString("utf8"), hasBOM: true };
	}
	return { content: buf.toString("utf8"), hasBOM: false };
}

function detectEol(content: string): "\n" | "\r\n" | "" {
	const idx = content.indexOf("\n");
	if (idx === -1) return "";
	return idx > 0 && content[idx - 1] === "\r" ? "\r\n" : "\n";
}

function isLikelyBinary(buf: Buffer): boolean {
	const slice = buf.subarray(0, Math.min(buf.length, BINARY_SCAN_BYTES));
	for (let i = 0; i < slice.length; i++) {
		if (slice[i] === 0) return true;
	}
	return false;
}
