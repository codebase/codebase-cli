/**
 * Read-only shell command allowlist. Direct port from
 * permission.go:65-90 on origin/anthropic-support. Adding a prefix
 * requires a code-review note: why is this safe?
 *
 * Matching rules:
 *   - exact match against the first piped/conditional segment
 *   - prefix-with-space match (so `git log` matches `git log --oneline`)
 *
 * Anything that survives the dangerous-pattern check AND matches a
 * read-only prefix bypasses the permission gate. Everything else prompts.
 */
export const READ_ONLY_SHELL_PREFIXES: readonly string[] = [
	// Listing + viewing
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"tree",
	"basename",
	"dirname",
	"realpath",

	// Search
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"find",
	"fd",
	"ag",
	"locate",

	// Git read
	"git status",
	"git log",
	"git diff",
	"git show",
	"git branch",
	"git remote",
	"git tag",
	"git stash list",
	"git config --get",
	"git rev-parse",
	"git ls-files",
	"git blame",
	"git describe",
	"git shortlog",
	"git reflog",

	// Build / test (run the same command repeatedly is fine)
	"go vet",
	"go build",
	"go test",
	"go fmt",
	"gofmt -l",
	"npm test",
	"npm run",
	"npm ls",
	"npm view",
	"npm outdated",
	"pnpm test",
	"pnpm run",
	"yarn test",
	"yarn run",
	"pytest",
	"python -c",
	"python3 -c",
	"ruby -e",
	"node -e",
	"node --check",
	"deno check",
	"cargo check",
	"cargo build",
	"cargo test",
	"cargo clippy",
	"make",
	"mvn test",
	"gradle test",

	// System inspection
	"du",
	"df",
	"uname",
	"whoami",
	"pwd",
	"env",
	"printenv",
	"hostname",
	"uptime",
	"id",
	"groups",
	"ps",
	"who",

	// Pipe-friendly text utilities
	"jq",
	"sort",
	"uniq",
	"tr",
	"cut",
	"awk",
	"sed",
	"echo",
	"printf",
	"date",
	"which",
	"type",
	"command -v",
	"diff",
	"cmp",
	"yes",
];

/**
 * Patterns that always force a permission prompt, even if the leading
 * command looks read-only. These are the "if you do this without
 * approval and it goes wrong, the user loses data" patterns.
 */
export const DANGEROUS_PATTERNS: readonly RegExp[] = [
	/\brm\s+-r?-?f\s+\//,
	/\brm\s+-r?-?f\s+~/,
	/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;/, // fork bomb
	/\bdd\s+(?:[a-z]+=\S+\s+)*of=\/dev\//,
	/\bmkfs(?:\.\w+)?\b/,
	/\bshutdown\b/,
	/\breboot\b/,
	/>\s*\/dev\/sd[a-z]/,
	/\bchmod\s+(?:-R\s+)?(?:777|0?000)\s+\//,
];

/** True if the shell command should require user approval before running. */
export function shellNeedsPermission(rawCommand: string): boolean {
	const cmd = rawCommand.trim();
	if (!cmd) return true;

	if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) return true;

	const firstSegment = splitFirstSegment(cmd);
	return !isReadOnlyPrefix(firstSegment);
}

/** True if the leading token of a chained shell expression is on the allowlist. */
function isReadOnlyPrefix(segment: string): boolean {
	const trimmed = segment.trim();
	for (const prefix of READ_ONLY_SHELL_PREFIXES) {
		if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
			return true;
		}
	}
	return false;
}

/**
 * Extract the first command in a chain. Splits on shell separators while
 * ignoring those inside single or double quotes — we don't want
 * `echo "rm -rf /"` to be misclassified.
 */
function splitFirstSegment(cmd: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble && (ch === "|" || ch === ";" || ch === "&")) {
			return cmd.slice(0, i);
		}
	}
	return cmd;
}
