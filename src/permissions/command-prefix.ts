/**
 * Extract a stable "command prefix" from a shell command line so that
 * trusting one `git commit -m "wip"` persists as trust for `git commit`
 * generally — not the exact string, and not all of `shell`. Mirrors
 * Claude Code's getSimpleCommandPrefix.
 *
 * Rules, kept deliberately simple (this is a UX convenience, not a
 * security boundary — the shell validator is the hard guard):
 *   - Take the first command of a compound (`a && b` → `a`).
 *   - Keep the binary + one subcommand if the binary is a known
 *     subcommand-style tool (git, npm, cargo, docker, kubectl, …):
 *     `git commit -m x` → `git commit`, `npm run build` → `npm run`.
 *   - Otherwise keep just the binary: `ls -la` → `ls`, `python x.py` → `python`.
 *   - Stop at the first token that looks like a flag, path, or value.
 *
 * Returns null when no meaningful prefix can be extracted (empty,
 * shell-builtin noise) — caller should fall back to whole-tool trust.
 */
const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
	"pip",
	"pip3",
	"poetry",
	"brew",
	"apt",
	"apt-get",
	"systemctl",
	"terraform",
	"make",
]);

export function commandPrefix(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;

	// First command of a compound / pipeline. Split on the common
	// separators; we only care about the leading segment for the prefix.
	const firstSegment = trimmed.split(/&&|\|\||;|\||\n/)[0]?.trim() ?? "";
	if (!firstSegment) return null;

	// Strip a leading env-assignment prefix (`FOO=bar cmd …`) and common
	// wrappers that don't change what's really being run.
	const tokens = firstSegment.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[i])) i++;
	while (i < tokens.length && (tokens[i] === "sudo" || tokens[i] === "nice" || tokens[i] === "env")) i++;
	if (i >= tokens.length) return null;

	const binary = baseName(tokens[i]);
	if (!binary) return null;

	if (SUBCOMMAND_TOOLS.has(binary)) {
		const sub = tokens[i + 1];
		// Only attach the subcommand if it's a bare word (not a flag/path).
		if (sub && /^[a-z][a-z0-9-]*$/i.test(sub)) {
			return `${binary} ${sub}`;
		}
	}
	return binary;
}

/** Strip a directory path from a binary token: `/usr/bin/git` → `git`. */
function baseName(token: string): string {
	const slash = token.lastIndexOf("/");
	const name = slash >= 0 ? token.slice(slash + 1) : token;
	// Drop a trailing path-ish or quote noise; keep word chars + - .
	return name.replace(/['"]/g, "");
}
