/**
 * Tiny regex-based syntax highlighter for code blocks inside markdown.
 * Each language is a flat list of `(regex, kind)` rules tried in order;
 * the first match wins, the matched span is emitted as a typed token,
 * and the scan resumes after it. Anything not matched falls through as
 * plain text.
 *
 * We deliberately do *not* take a 6 MB dep (highlight.js, prismjs) just
 * to colorize terminal code blocks — these rules handle 95% of what an
 * LLM emits and stay easy to read. If a language isn't in `LANGS`, the
 * caller renders the code block as plain text.
 */

export type TokenKind =
	| "text"
	| "keyword"
	| "string"
	| "number"
	| "comment"
	| "type"
	| "function"
	| "operator"
	| "punctuation"
	| "property"
	| "regex";

export interface Token {
	kind: TokenKind;
	text: string;
}

interface Rule {
	pattern: RegExp;
	kind: TokenKind;
}

const TS_KEYWORDS = [
	"abstract",
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"implements",
	"import",
	"in",
	"infer",
	"instanceof",
	"interface",
	"is",
	"keyof",
	"let",
	"namespace",
	"new",
	"null",
	"of",
	"package",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"set",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"false",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
];

const PY_KEYWORDS = [
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"False",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"None",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"True",
	"try",
	"while",
	"with",
	"yield",
];

const GO_KEYWORDS = [
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
	"nil",
	"true",
	"false",
];

const SH_KEYWORDS = [
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"in",
	"do",
	"done",
	"while",
	"until",
	"case",
	"esac",
	"function",
	"return",
	"exit",
	"break",
	"continue",
	"local",
	"export",
	"readonly",
	"declare",
	"set",
	"unset",
	"shift",
];

const TS_RULES: Rule[] = [
	{ pattern: /^\/\/[^\n]*/, kind: "comment" },
	{ pattern: /^\/\*[\s\S]*?\*\//, kind: "comment" },
	{ pattern: /^`(?:[^`\\]|\\.)*`/, kind: "string" },
	{ pattern: /^"(?:[^"\\\n]|\\.)*"/, kind: "string" },
	{ pattern: /^'(?:[^'\\\n]|\\.)*'/, kind: "string" },
	{ pattern: /^\b(?:0x[0-9a-fA-F]+|0b[01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/, kind: "number" },
	{ pattern: new RegExp(`^\\b(?:${TS_KEYWORDS.join("|")})\\b`), kind: "keyword" },
	{ pattern: /^\b[A-Z][A-Za-z0-9_]*\b/, kind: "type" },
	{ pattern: /^[A-Za-z_$][\w$]*(?=\s*\()/, kind: "function" },
	{ pattern: /^[A-Za-z_$][\w$]*(?=\s*:)/, kind: "property" },
	{ pattern: /^[+\-*/%=<>!&|^~?:]+/, kind: "operator" },
	{ pattern: /^[{}[\]().,;]/, kind: "punctuation" },
];

const PY_RULES: Rule[] = [
	{ pattern: /^#[^\n]*/, kind: "comment" },
	{ pattern: /^"""[\s\S]*?"""/, kind: "string" },
	{ pattern: /^'''[\s\S]*?'''/, kind: "string" },
	{ pattern: /^"(?:[^"\\\n]|\\.)*"/, kind: "string" },
	{ pattern: /^'(?:[^'\\\n]|\\.)*'/, kind: "string" },
	{ pattern: /^\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/, kind: "number" },
	{ pattern: new RegExp(`^\\b(?:${PY_KEYWORDS.join("|")})\\b`), kind: "keyword" },
	{ pattern: /^\b[A-Z][A-Za-z0-9_]*\b/, kind: "type" },
	{ pattern: /^[A-Za-z_][\w]*(?=\s*\()/, kind: "function" },
	{ pattern: /^[+\-*/%=<>!&|^~]+/, kind: "operator" },
	{ pattern: /^[{}[\]().,:;]/, kind: "punctuation" },
];

const GO_RULES: Rule[] = [
	{ pattern: /^\/\/[^\n]*/, kind: "comment" },
	{ pattern: /^\/\*[\s\S]*?\*\//, kind: "comment" },
	{ pattern: /^`[\s\S]*?`/, kind: "string" },
	{ pattern: /^"(?:[^"\\\n]|\\.)*"/, kind: "string" },
	{ pattern: /^'(?:[^'\\]|\\.)*'/, kind: "string" },
	{ pattern: /^\b\d+\.?\d*\b/, kind: "number" },
	{ pattern: new RegExp(`^\\b(?:${GO_KEYWORDS.join("|")})\\b`), kind: "keyword" },
	{ pattern: /^\b[A-Z][A-Za-z0-9_]*\b/, kind: "type" },
	{ pattern: /^[A-Za-z_][\w]*(?=\s*\()/, kind: "function" },
	{ pattern: /^[+\-*/%=<>!&|^~]+/, kind: "operator" },
	{ pattern: /^[{}[\]().,;:]/, kind: "punctuation" },
];

const SH_RULES: Rule[] = [
	{ pattern: /^#[^\n]*/, kind: "comment" },
	{ pattern: /^"(?:[^"\\\n]|\\.)*"/, kind: "string" },
	{ pattern: /^'[^'\n]*'/, kind: "string" },
	{ pattern: /^\$[A-Za-z_][\w]*/, kind: "property" },
	{ pattern: /^\$\{[^}]*\}/, kind: "property" },
	{ pattern: /^\b\d+\b/, kind: "number" },
	{ pattern: new RegExp(`^\\b(?:${SH_KEYWORDS.join("|")})\\b`), kind: "keyword" },
	{ pattern: /^-{1,2}[A-Za-z][\w-]*/, kind: "operator" },
	{ pattern: /^[|&;<>(){}]+/, kind: "punctuation" },
];

const JSON_RULES: Rule[] = [
	{ pattern: /^"(?:[^"\\\n]|\\.)*"(?=\s*:)/, kind: "property" },
	{ pattern: /^"(?:[^"\\\n]|\\.)*"/, kind: "string" },
	{ pattern: /^\b(?:true|false|null)\b/, kind: "keyword" },
	{ pattern: /^-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/, kind: "number" },
	{ pattern: /^[{}[\],]/, kind: "punctuation" },
	{ pattern: /^:/, kind: "operator" },
];

const LANGS: Record<string, Rule[]> = {
	ts: TS_RULES,
	tsx: TS_RULES,
	js: TS_RULES,
	jsx: TS_RULES,
	javascript: TS_RULES,
	typescript: TS_RULES,
	py: PY_RULES,
	python: PY_RULES,
	go: GO_RULES,
	golang: GO_RULES,
	sh: SH_RULES,
	bash: SH_RULES,
	zsh: SH_RULES,
	shell: SH_RULES,
	json: JSON_RULES,
};

/** Get the rule set for a language slug, or null if unsupported. */
export function rulesFor(lang: string | undefined): Rule[] | null {
	if (!lang) return null;
	return LANGS[lang.toLowerCase()] ?? null;
}

/**
 * Tokenize `code` according to `lang`. Returns one big flat token list
 * with whitespace and unmatched content emitted as `text`. The caller
 * is responsible for rendering each token in its kind's color.
 */
export function highlight(code: string, lang: string | undefined): Token[] {
	const rules = rulesFor(lang);
	if (!rules) return [{ kind: "text", text: code }];

	const out: Token[] = [];
	let buffer = "";
	let i = 0;
	while (i < code.length) {
		// Eat whitespace into the rolling text buffer — saves work and keeps
		// indentation intact in the output.
		const ch = code[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			buffer += ch;
			i++;
			continue;
		}
		const slice = code.slice(i);
		let matched: { kind: TokenKind; len: number } | null = null;
		for (const rule of rules) {
			const m = slice.match(rule.pattern);
			if (m && m.index === 0) {
				matched = { kind: rule.kind, len: m[0].length };
				break;
			}
		}
		if (matched) {
			if (buffer) {
				out.push({ kind: "text", text: buffer });
				buffer = "";
			}
			out.push({ kind: matched.kind, text: slice.slice(0, matched.len) });
			i += matched.len;
			continue;
		}
		// No match — accumulate one char into the plain-text buffer.
		buffer += ch;
		i++;
	}
	if (buffer) out.push({ kind: "text", text: buffer });
	return out;
}

/** Map a token kind to an Ink color. Returns undefined for plain text. */
export function colorForKind(kind: TokenKind): string | undefined {
	switch (kind) {
		case "keyword":
			return "magenta";
		case "string":
			return "green";
		case "number":
			return "yellow";
		case "comment":
			return "gray";
		case "type":
			return "cyan";
		case "function":
			return "blue";
		case "property":
			return "cyan";
		case "regex":
			return "yellow";
		case "operator":
		case "punctuation":
		case "text":
			return undefined;
	}
}
