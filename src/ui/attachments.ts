import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface Attachment {
	token: string;
	relPath: string;
	absPath: string;
	content: string;
}

export const MAX_ATTACHMENT_BYTES = 128 * 1024;
export const MAX_ATTACHMENTS = 8;

/**
 * Scan the prompt for `@<path>` tokens and resolve each to a readable
 * file under (or adjacent to) the cwd. Returns one entry per resolved
 * file; unresolved `@` mentions don't appear here and stay as literal
 * text — we never silently drop or rewrite user input.
 *
 * Skip rules:
 *   - tokens without a slash or dot (email-style @alice mentions)
 *   - paths over 256 chars (clearly not a real path)
 *   - non-files (directories, sockets, ...)
 *   - files larger than MAX_ATTACHMENT_BYTES
 *   - past MAX_ATTACHMENTS total attachments per prompt
 */
export function collectAttachments(text: string, cwd: string): Attachment[] {
	const out: Attachment[] = [];
	const seen = new Set<string>();
	const pattern = /@([A-Za-z0-9_./-]+)/g;
	for (const match of text.matchAll(pattern)) {
		if (out.length >= MAX_ATTACHMENTS) break;
		const rel = match[1];
		if (!rel || rel.length > 256) continue;
		if (!rel.includes("/") && !rel.includes(".")) continue;
		const abs = isAbsolute(rel) ? rel : join(cwd, rel);
		if (seen.has(abs)) continue;
		seen.add(abs);
		try {
			const stat = statSync(abs);
			if (!stat.isFile()) continue;
			if (stat.size > MAX_ATTACHMENT_BYTES) continue;
			const content = readFileSync(abs, "utf8");
			out.push({ token: match[0], relPath: rel, absPath: abs, content });
		} catch {
			// File doesn't exist or isn't readable — leave the token in text.
		}
	}
	return out;
}

/**
 * Build the agent-bound prompt with attachments inlined as fenced code
 * blocks above the user's actual ask. The original `@path` tokens stay
 * in the text so the model can correlate the references with the
 * attached content.
 */
export function buildAttachmentPrompt(text: string, attachments: readonly Attachment[]): string {
	const parts: string[] = ["Attached files (auto-inlined from @ mentions):", ""];
	for (const a of attachments) {
		parts.push(`### ${a.relPath}`);
		parts.push("```");
		parts.push(a.content);
		parts.push("```");
		parts.push("");
	}
	parts.push("---");
	parts.push(text);
	return parts.join("\n");
}
