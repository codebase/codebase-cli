import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Instruction files are layered, lowest → highest specificity, every
 * present layer included:
 *
 *   1. User      — first of ~/.codebase/{AGENTS.md, CLAUDE.md}; the
 *                  user's personal conventions, apply to every project.
 *   2. Project   — first of AGENTS.md / CLAUDE.md / CODEX.md /
 *                  .cursorrules at the cwd root. First-present wins so a
 *                  project carrying both CLAUDE.md and AGENTS.md doesn't
 *                  inject duplicates.
 *   3. Rules     — every .md in <cwd>/.codebase/rules/, sorted by name.
 *   4. Local     — first of AGENTS.local.md / CLAUDE.local.md at the cwd
 *                  root; personal, gitignored project overrides.
 *
 * Markdown layers support `@path` imports: a token like `@./docs/api.md`
 * or `@~/notes/style.md` on a normal text line is replaced inline with
 * that file's content. Paths resolve relative to the importing file;
 * imports recurse (depth-capped) with cycle detection; tokens inside
 * fenced code blocks and tokens that don't name a readable text file are
 * left untouched.
 */
const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md", "CODEX.md", ".cursorrules"] as const;
const USER_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const LOCAL_FILES = ["AGENTS.local.md", "CLAUDE.local.md"] as const;

/** Hard cap on each section AND the combined addendum. Keeps a runaway
 *  instruction tree from blowing the prompt. */
const MAX_BYTES = 64 * 1024;

const MAX_IMPORT_DEPTH = 5;
const IMPORTABLE = /\.(md|markdown|txt|mdc)$/i;
/** `@path` token at line start or after whitespace. The path may be
 *  ~/..., /abs, ./rel, or bare-relative. Existence check is the real
 *  filter — `user@host` and `@decorator` never resolve to a file. */
const IMPORT_TOKEN = /(^|\s)@([\w~./-]+)/g;

export interface ProjectFilesOptions {
	home?: string;
}

export function buildProjectFilesAddendum(cwd: string, options: ProjectFilesOptions = {}): string {
	const home = options.home ?? homedir();
	const sections: string[] = [];

	const user = firstPresent(join(home, ".codebase"), USER_FILES);
	if (user) {
		sections.push(section(`User instructions (~/.codebase/${user.name})`, withImports(user, home)));
	}

	const project = firstPresent(cwd, PROJECT_FILES);
	if (project) {
		sections.push(section(`Project instructions (${project.name})`, withImports(project, home)));
	}

	for (const rule of ruleFiles(cwd)) {
		sections.push(section(`Project rules (.codebase/rules/${rule.name})`, withImports(rule, home)));
	}

	const local = firstPresent(cwd, LOCAL_FILES);
	if (local) {
		sections.push(section(`Local project instructions (${local.name})`, withImports(local, home)));
	}

	if (sections.length === 0) return "";
	return capBytes(sections.join(""), MAX_BYTES * 2);
}

interface InstructionFile {
	name: string;
	path: string;
	content: string;
	truncated: boolean;
}

function firstPresent(root: string, names: readonly string[]): InstructionFile | undefined {
	for (const name of names) {
		const file = readInstructionFile(join(root, name), name);
		if (file) return file;
	}
	return undefined;
}

function ruleFiles(cwd: string): InstructionFile[] {
	const dir = join(cwd, ".codebase", "rules");
	let entries: string[];
	try {
		entries = readdirSync(dir)
			.filter((n) => n.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	const out: InstructionFile[] = [];
	for (const name of entries) {
		const file = readInstructionFile(join(dir, name), name);
		if (file) out.push(file);
	}
	return out;
}

function readInstructionFile(path: string, name: string): InstructionFile | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return undefined;
		let content = readFileSync(path, "utf8");
		let truncated = false;
		if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
			content = content.slice(0, MAX_BYTES);
			while (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
				content = content.slice(0, -1);
			}
			truncated = true;
		}
		return { name, path, content, truncated };
	} catch {
		return undefined;
	}
}

function section(title: string, body: string): string {
	return `\n\n# ${title}\n\n${body.trim()}\n`;
}

function withImports(file: InstructionFile, home: string): string {
	const body =
		// .cursorrules isn't markdown; imports apply to markdown layers only.
		file.name.endsWith(".cursorrules") || !IMPORTABLE.test(file.name)
			? file.content
			: resolveImports(file.content, dirname(file.path), home, new Set([safeRealpath(file.path)]), 0);
	return file.truncated ? `${body}\n\n(…truncated; full file at ${file.path})` : body;
}

function resolveImports(content: string, baseDir: string, home: string, visited: Set<string>, depth: number): string {
	if (depth >= MAX_IMPORT_DEPTH) return content;
	const out: string[] = [];
	let inFence = false;
	for (const line of content.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence || !line.includes("@")) {
			out.push(line);
			continue;
		}
		out.push(
			line.replace(IMPORT_TOKEN, (match, lead: string, token: string) => {
				const imported = readImport(token, baseDir, home, visited);
				if (imported === undefined) return match;
				const inlined = resolveImports(imported.content, dirname(imported.path), home, visited, depth + 1);
				return `${lead}\n\n<!-- imported from ${token} -->\n${inlined.trim()}\n<!-- end import -->\n`;
			}),
		);
	}
	return out.join("\n");
}

function readImport(
	token: string,
	baseDir: string,
	home: string,
	visited: Set<string>,
): { path: string; content: string } | undefined {
	if (!IMPORTABLE.test(token)) return undefined;
	const path = token.startsWith("~/")
		? join(home, token.slice(2))
		: isAbsolute(token)
			? token
			: resolve(baseDir, token);
	const real = safeRealpath(path);
	if (visited.has(real)) return undefined; // cycle — leave the token as text
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
		visited.add(real);
		return { path, content: readFileSync(path, "utf8") };
	} catch {
		return undefined;
	}
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function capBytes(text: string, max: number): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n(…instruction files truncated at ${Math.round(max / 1024)}KB)\n`;
}
