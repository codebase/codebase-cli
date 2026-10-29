import { createRequire } from "node:module";
import { basename, extname } from "node:path";

/** A run of code text with an optional SGR foreground code ("38;5;170"). */
export interface Segment {
	text: string;
	style?: string;
}

const ESC = "\x1b[";
// Foreground/italic off only — never a full reset, so a caller's background survives.
const STYLE_OFF = `${ESC}39;23m`;

const COMMENT = "38;5;244;3";
const KEYWORD = "38;5;170";
const STRING = "38;5;114";
const NUMBER = "38;5;173";
const TYPE = "38;5;180";
const FUNCTION = "38;5;75";
const RED = "38;5;204";

const SCOPE_STYLES: Record<string, string> = {
	comment: COMMENT,
	quote: COMMENT,
	doctag: KEYWORD,
	keyword: KEYWORD,
	"selector-tag": KEYWORD,
	"selector-pseudo": KEYWORD,
	meta: KEYWORD,
	"meta keyword": KEYWORD,
	operator: KEYWORD,
	string: STRING,
	regexp: STRING,
	addition: STRING,
	char: STRING,
	"template-tag": STRING,
	number: NUMBER,
	literal: NUMBER,
	symbol: NUMBER,
	bullet: NUMBER,
	attr: NUMBER,
	attribute: NUMBER,
	"selector-attr": NUMBER,
	built_in: TYPE,
	type: TYPE,
	"selector-class": TYPE,
	"title.class": TYPE,
	"title.class.inherited": TYPE,
	title: FUNCTION,
	"title.function": FUNCTION,
	section: FUNCTION,
	"selector-id": FUNCTION,
	link: FUNCTION,
	name: RED,
	variable: RED,
	"template-variable": RED,
	deletion: RED,
	property: RED,
	tag: "38;5;245",
};

const FILENAME_LANGS: Record<string, string> = {
	makefile: "makefile",
	dockerfile: "dockerfile",
	gemfile: "ruby",
	rakefile: "ruby",
	cmakelists: "cmake",
};

// Local shape instead of highlight.js's own types, which drag in DOM globals.
interface HLJSApi {
	getLanguage(name: string): object | undefined;
	highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
	highlightAuto(code: string, subset: string[]): { language?: string; relevance: number };
}

// Auto-detection only weighs common languages: across all ~190 grammars it is
// slow and short snippets land on obscure ones.
const DETECT_SUBSET = [
	"xml",
	"css",
	"javascript",
	"typescript",
	"python",
	"ruby",
	"csharp",
	"c",
	"cpp",
	"java",
	"go",
	"rust",
	"php",
	"sql",
	"yaml",
	"diff",
	"ini",
];
const MIN_RELEVANCE = 2;

const SHELL_COMMANDS = new Set(
	(
		"apt apt-get bash brew bun cargo cat cd chmod chown codebase cp curl deno docker dotnet echo export gh git go " +
		"grep kill kubectl ln ls make mkdir mv node npm npx open pip pip3 pnpm python python3 rm rustc sed ssh sudo " +
		"tar touch uv uvx wget xdg-open yarn"
	).split(" "),
);

let hljs: HLJSApi | undefined;
function load(): HLJSApi {
	// Loaded on first use: registering ~190 grammars costs startup time otherwise.
	hljs ??= createRequire(import.meta.url)("highlight.js") as HLJSApi;
	return hljs;
}

/** Resolve a fence tag or alias ("ts", "cs", "html") to a registered grammar name. */
export function resolveLanguage(lang: string | undefined): string | undefined {
	if (!lang) return undefined;
	const id = lang.trim().toLowerCase().split(/[\s{]/)[0];
	if (!id) return undefined;
	const grammar = load().getLanguage(id);
	return grammar ? id : undefined;
}

/** Guess a code block's language from its content; undefined reads as plain text. */
export function detectLanguage(code: string): string | undefined {
	const lines = code.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
	if (lines.length === 0) return undefined;
	if (lines.every(looksLikeShell)) return "bash";
	if (/^\s*(select|insert|update|delete|create|alter|drop|with)\s/i.test(lines[0])) return "sql";
	// Prose (log output, plain sentences) has no code punctuation; detection would still guess a language.
	if (!/[{}()<>=;:[\]]/.test(code)) return undefined;
	try {
		const parsed: unknown = JSON.parse(code);
		if (typeof parsed === "object" && parsed !== null) return "json";
	} catch {}
	try {
		const result = load().highlightAuto(code, DETECT_SUBSET);
		return result.relevance >= MIN_RELEVANCE ? result.language : undefined;
	} catch {
		return undefined;
	}
}

function looksLikeShell(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith("$ ")) return true;
	const first = trimmed.split(/\s+/)[0] ?? "";
	return first.startsWith("./") || SHELL_COMMANDS.has(first);
}

/** Guess a grammar from a file path's extension or well-known basename. */
export function languageForPath(path: string): string | undefined {
	const base = basename(path).toLowerCase();
	const byName = FILENAME_LANGS[base.replace(/\.txt$/, "")];
	if (byName) return byName;
	const ext = extname(base).slice(1);
	return ext ? resolveLanguage(ext) : undefined;
}

/**
 * Tokenize code into per-line segments. Highlighting runs over the whole
 * text so multi-line constructs (block comments, template strings) stay
 * colored across lines. Unknown languages come back as plain segments.
 */
export function highlightSegments(code: string, lang: string | undefined): Segment[][] {
	const language = resolveLanguage(lang);
	if (!language) return code.split("\n").map((text) => [{ text }]);
	let html: string;
	try {
		html = load().highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return code.split("\n").map((text) => [{ text }]);
	}
	const lines = parseHtml(html);
	return SHELL_LANGS.has(language) ? lines.map(colorShellCommands) : lines;
}

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shellsession"]);
// Wrappers whose next word is the real command (`sudo apt install`).
const COMMAND_PREFIXES = new Set(["sudo", "time", "env", "exec", "nohup", "xargs", "command"]);

/**
 * hljs's bash grammar only knows shell builtins, so `git status` stays
 * uncolored. Color the word in command position (line start, or after
 * && || | ;) plus `-flag` arguments in the unstyled stretches.
 */
function colorShellCommands(line: Segment[]): Segment[] {
	const out: Segment[] = [];
	let expectCommand: boolean = true;
	for (const seg of line) {
		if (seg.style) {
			const isCommand: boolean = expectCommand && seg.style === TYPE;
			out.push(isCommand ? { text: seg.text, style: FUNCTION } : seg);
			if (seg.text.trim()) expectCommand = isCommand && COMMAND_PREFIXES.has(seg.text.trim());
			continue;
		}
		for (const token of seg.text.match(/\s+|&&|\|\||[|;]|[^\s|;&]+|&/g) ?? []) {
			if (/^(&&|\|\||[|;])$/.test(token)) {
				expectCommand = true;
				out.push({ text: token, style: KEYWORD });
			} else if (/^\s+$/.test(token) || (expectCommand && token === "$")) {
				out.push({ text: token });
			} else if (expectCommand && !token.includes("=")) {
				expectCommand = COMMAND_PREFIXES.has(token);
				out.push({ text: token, style: FUNCTION });
			} else {
				out.push(token.startsWith("-") ? { text: token, style: NUMBER } : { text: token });
			}
		}
	}
	return out;
}

/** Highlight a code block to one ANSI string per line (fg colors only), detecting untagged languages. */
export function highlightCode(code: string, lang: string | undefined): string[] {
	return highlightSegments(code, resolveLanguage(lang) ?? detectLanguage(code)).map(segmentsToAnsi);
}

export function segmentsToAnsi(segments: Segment[]): string {
	return segments.map((s) => (s.style ? `${ESC}${s.style}m${s.text}${STYLE_OFF}` : s.text)).join("");
}

function parseHtml(html: string): Segment[][] {
	const lines: Segment[][] = [[]];
	const stack: (string | undefined)[] = [];
	const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (m[1] !== undefined) {
			stack.push(styleFor(m[1]) ?? stack[stack.length - 1]);
		} else if (m[2] !== undefined) {
			const style = stack[stack.length - 1];
			const parts = decodeEntities(m[2]).split("\n");
			parts.forEach((text, i) => {
				if (i > 0) lines.push([]);
				if (text) lines[lines.length - 1].push(style ? { text, style } : { text });
			});
		} else {
			stack.pop();
		}
	}
	return lines;
}

function styleFor(className: string): string | undefined {
	// hljs v11 renders scope "title.function" as class "hljs-title function_".
	const parts = className.split(/\s+/);
	const head = parts[0]?.replace(/^hljs-/, "");
	if (!head || head.startsWith("language-")) return undefined;
	const sub = parts
		.slice(1)
		.map((p) => p.replace(/_+$/, ""))
		.filter(Boolean);
	return SCOPE_STYLES[[head, ...sub].join(".")] ?? SCOPE_STYLES[head];
}

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}
