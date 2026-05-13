import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_TYPES, type MemoryFrontmatter, type MemoryRecord, type MemoryType, parseMemoryType } from "./types.js";

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const FILENAME_PATTERN = /^[a-z0-9_-]{1,80}\.md$/;

export interface MemoryStoreOptions {
	cwd: string;
	/** Override the data root. Defaults to ~/.codebase. */
	dataRoot?: string;
}

/**
 * Per-project memory: one directory at `~/.codebase/projects/{hash}/memory/`
 * keyed off cwd. MEMORY.md is the index injected into the agent's system
 * prompt; per-type *.md files hold full bodies. The 4-type taxonomy
 * (user/feedback/project/reference) is enforced at write time so a typo
 * doesn't silently land an entry of the wrong kind.
 */
export class MemoryStore {
	private readonly cwd: string;
	private readonly dir: string;

	constructor(options: MemoryStoreOptions) {
		this.cwd = options.cwd;
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		const projectHash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 8);
		this.dir = join(dataRoot, "projects", projectHash, "memory");
	}

	get directory(): string {
		return this.dir;
	}

	/** Read a single record by filename (e.g. "user_role.md"). Returns null if missing. */
	read(filename: string): MemoryRecord | null {
		const safe = sanitizeFilename(filename);
		if (!safe) return null;
		const path = join(this.dir, safe);
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		const stat = statSync(path);
		const parsed = parseMemoryFile(raw);
		if (!parsed) return null;
		return { filename: safe, ...parsed.frontmatter, body: parsed.body, updatedAt: stat.mtimeMs };
	}

	list(typeFilter?: MemoryType): MemoryRecord[] {
		if (!existsSync(this.dir)) return [];
		const out: MemoryRecord[] = [];
		for (const name of readdirSync(this.dir)) {
			if (name === "MEMORY.md") continue;
			if (!name.endsWith(".md")) continue;
			const record = this.read(name);
			if (!record) continue;
			if (typeFilter && record.type !== typeFilter) continue;
			out.push(record);
		}
		out.sort((a, b) => a.filename.localeCompare(b.filename));
		return out;
	}

	save(input: { filename: string; name: string; description: string; type: MemoryType; body: string }): MemoryRecord {
		const safe = sanitizeFilename(input.filename);
		if (!safe) {
			throw new Error(`memory filename must match ${FILENAME_PATTERN}; got "${input.filename}"`);
		}
		if (!parseMemoryType(input.type)) {
			throw new Error(`memory type must be one of ${MEMORY_TYPES.join(", ")}; got "${input.type}"`);
		}
		mkdirSync(this.dir, { recursive: true });
		const body = serializeMemoryFile({
			frontmatter: { name: input.name, description: input.description, type: input.type },
			body: input.body,
		});
		const path = join(this.dir, safe);
		writeFileSync(path, body, { mode: 0o644 });
		return {
			filename: safe,
			name: input.name,
			description: input.description,
			type: input.type,
			body: input.body,
			updatedAt: statSync(path).mtimeMs,
		};
	}

	delete(filename: string): boolean {
		const safe = sanitizeFilename(filename);
		if (!safe) return false;
		const path = join(this.dir, safe);
		if (!existsSync(path)) return false;
		unlinkSync(path);
		return true;
	}

	/** Read MEMORY.md verbatim. Returns "" when no index exists. */
	index(): string {
		const path = join(this.dir, "MEMORY.md");
		if (!existsSync(path)) return "";
		return readFileSync(path, "utf8");
	}

	writeIndex(content: string): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, "MEMORY.md"), content, { mode: 0o644 });
	}

	/**
	 * MEMORY.md content trimmed to fit a system-prompt injection budget.
	 * Line cut first (≤200 lines), then byte cut at the next newline so
	 * we never split a list entry mid-line. Keeps injection length stable
	 * across saves so prompt-cache boundaries don't shift.
	 */
	truncatedIndex(): string {
		const raw = this.index();
		if (!raw) return "";
		const lines = raw.split("\n");
		const lineLimited = lines.length > MAX_INDEX_LINES ? lines.slice(0, MAX_INDEX_LINES).join("\n") : raw;
		if (Buffer.byteLength(lineLimited, "utf8") <= MAX_INDEX_BYTES) return lineLimited;
		// Byte cut at the previous newline boundary.
		const buf = Buffer.from(lineLimited, "utf8");
		let cut = MAX_INDEX_BYTES;
		while (cut > 0 && buf[cut] !== 0x0a) cut--;
		return buf.subarray(0, cut).toString("utf8");
	}
}

// ─── helpers ─────────────────────────────────────────────────

function sanitizeFilename(filename: string): string | null {
	const trimmed = filename.trim();
	if (!FILENAME_PATTERN.test(trimmed)) return null;
	return trimmed;
}

interface ParsedMemory {
	frontmatter: MemoryFrontmatter;
	body: string;
}

function parseMemoryFile(raw: string): ParsedMemory | null {
	if (!raw.startsWith("---")) return null;
	const closeIdx = raw.indexOf("\n---", 3);
	if (closeIdx === -1) return null;
	const fmRaw = raw.slice(3, closeIdx).trim();
	const body = raw.slice(closeIdx + 4).replace(/^\n/, "");

	const fields: Record<string, string> = {};
	for (const line of fmRaw.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line
			.slice(idx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		fields[key] = value;
	}
	const type = fields.type ? parseMemoryType(fields.type) : null;
	if (!type || !fields.name || !fields.description) return null;
	return {
		frontmatter: { name: fields.name, description: fields.description, type },
		body,
	};
}

function serializeMemoryFile(input: ParsedMemory): string {
	const lines = [
		"---",
		`name: ${input.frontmatter.name}`,
		`description: ${input.frontmatter.description}`,
		`type: ${input.frontmatter.type}`,
		"---",
		"",
		input.body.replace(/\n+$/, ""),
		"",
	];
	return lines.join("\n");
}
