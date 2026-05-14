import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssetLoader } from "./loader.js";
import type { PromptAsset, SkillAsset, TemplateAsset } from "./types.js";

/**
 * Loads user-authored assets from `~/.codebase/{skills,templates,prompts}/`.
 * Each file is a single asset: a Markdown body with optional YAML-ish
 * frontmatter that supplies id / name / description / tags. Filename
 * (without extension) is the default id when frontmatter omits one.
 *
 * Frontmatter format (subset of YAML — bare strings, [a, b] lists,
 * `key: value` lines only; no nested structures):
 *
 *   ---
 *   id: optimize
 *   name: Optimize hot path
 *   description: Refactor for performance.
 *   tags: [perf, refactor]
 *   preferredModel: claude-opus-4-7
 *   ---
 *
 *   <markdown body — used as systemPrompt for skills, body for
 *   templates / prompts>
 *
 * Missing files / directories are silently skipped. Malformed files
 * are logged once to stderr (not thrown) so a single bad asset
 * doesn't break the agent. Filesystem errors during walk are also
 * logged-and-skipped.
 *
 * The asset registry already merges by `kind:id` with later loaders
 * winning, so the user can shadow a bundled skill by dropping a file
 * at `~/.codebase/skills/<id>.md`.
 */
export class LocalLoader implements AssetLoader {
	readonly source = "user" as const;
	private readonly rootDir: string;

	constructor(rootDir?: string) {
		this.rootDir = rootDir ?? join(homedir(), ".codebase");
	}

	async listSkills(): Promise<readonly SkillAsset[]> {
		const dir = join(this.rootDir, "skills");
		return walkAssets(dir, (entry) => parseSkill(entry));
	}

	async listTemplates(): Promise<readonly TemplateAsset[]> {
		const dir = join(this.rootDir, "templates");
		return walkAssets(dir, (entry) => parseTemplate(entry));
	}

	async listPrompts(): Promise<readonly PromptAsset[]> {
		const dir = join(this.rootDir, "prompts");
		return walkAssets(dir, (entry) => parsePrompt(entry));
	}
}

interface ParsedFile {
	defaultId: string;
	frontmatter: Record<string, string | readonly string[]>;
	body: string;
}

/**
 * Walk a directory of `.md` files, parse each one, and produce assets.
 * Empty / missing directory yields []; bad files are reported to stderr
 * and skipped so a single typo doesn't poison the whole list.
 */
function walkAssets<T>(dir: string, build: (entry: ParsedFile) => T | undefined): T[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			process.stderr.write(`[skills] could not list ${dir}: ${(err as Error).message}\n`);
		}
		return [];
	}
	const results: T[] = [];
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const fullPath = join(dir, name);
		try {
			const stat = statSync(fullPath);
			if (!stat.isFile()) continue;
			const raw = readFileSync(fullPath, "utf8");
			const parsed = parseFile(name, raw);
			const asset = build(parsed);
			if (asset) results.push(asset);
		} catch (err) {
			process.stderr.write(`[skills] could not parse ${fullPath}: ${(err as Error).message}\n`);
		}
	}
	return results;
}

/**
 * Split a markdown file into frontmatter + body. Tolerates files
 * without frontmatter entirely (whole file becomes the body) and
 * preserves the body's leading whitespace untouched so prompt authors
 * who want blank lines at the start get them.
 */
function parseFile(filename: string, raw: string): ParsedFile {
	const defaultId = filename.replace(/\.md$/, "");
	const FENCE = "---";
	const normalized = raw.replace(/^﻿/, ""); // strip BOM
	if (!normalized.startsWith(FENCE)) {
		return { defaultId, frontmatter: {}, body: normalized };
	}
	// Find the closing fence on its own line (the most permissive parse
	// of YAML frontmatter delimiters).
	const closeIdx = normalized.indexOf(`\n${FENCE}`, FENCE.length);
	if (closeIdx === -1) {
		return { defaultId, frontmatter: {}, body: normalized };
	}
	const fmText = normalized.slice(FENCE.length, closeIdx).trim();
	const bodyStart = closeIdx + 1 + FENCE.length;
	// Skip the newline that follows the closing fence so the body
	// doesn't start with a blank line just because we hit the fence.
	const body = normalized.slice(bodyStart).replace(/^\r?\n/, "");
	return { defaultId, frontmatter: parseFrontmatter(fmText), body };
}

/**
 * Parse the simple YAML subset we accept. Each non-blank line is
 * `key: value`. Values that look like `[a, b, c]` become string lists.
 * Bare strings get whitespace-trimmed; quoted strings honor `"…"` and
 * `'…'`. We don't support nested objects, multi-line values, or
 * anchors — keep it boring so users can hand-write the headers.
 */
function parseFrontmatter(text: string): Record<string, string | readonly string[]> {
	const out: Record<string, string | readonly string[]> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!key) continue;
		if (value.startsWith("[") && value.endsWith("]")) {
			out[key] = value
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter((s) => s.length > 0);
		} else {
			out[key] = unquote(value);
		}
	}
	return out;
}

function unquote(s: string): string {
	if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
		const q = s[0];
		if (s.endsWith(q)) return s.slice(1, -1);
	}
	return s;
}

function strOrUndef(value: string | readonly string[] | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function strArrOrUndef(value: string | readonly string[] | undefined): readonly string[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function parseSkill(entry: ParsedFile): SkillAsset | undefined {
	const fm = entry.frontmatter;
	const id = strOrUndef(fm.id) ?? entry.defaultId;
	if (!id) return undefined;
	return {
		kind: "skill",
		id,
		source: "user",
		name: strOrUndef(fm.name) ?? id,
		description: strOrUndef(fm.description) ?? "",
		systemPrompt: entry.body,
		tags: strArrOrUndef(fm.tags),
		preferredModel: strOrUndef(fm.preferredModel),
	};
}

function parseTemplate(entry: ParsedFile): TemplateAsset | undefined {
	const fm = entry.frontmatter;
	const id = strOrUndef(fm.id) ?? entry.defaultId;
	if (!id) return undefined;
	return {
		kind: "template",
		id,
		source: "user",
		name: strOrUndef(fm.name) ?? id,
		description: strOrUndef(fm.description) ?? "",
		body: entry.body,
		tags: strArrOrUndef(fm.tags),
	};
}

function parsePrompt(entry: ParsedFile): PromptAsset | undefined {
	const fm = entry.frontmatter;
	const id = strOrUndef(fm.id) ?? entry.defaultId;
	if (!id) return undefined;
	return {
		kind: "prompt",
		id,
		source: "user",
		name: strOrUndef(fm.name) ?? id,
		description: strOrUndef(fm.description) ?? "",
		body: entry.body,
		tags: strArrOrUndef(fm.tags),
	};
}
