/**
 * Pre-flight check for shell commands the model wants to run. Returns
 * a verdict the shell tool consults BEFORE spawning. The point isn't
 * to enforce policy — the permission store does that — it's to refuse
 * a small set of unambiguously destructive patterns that no sensible
 * agent has any reason to issue, even by accident.
 *
 * Examples of what we block:
 *   rm -rf /                  (delete root)
 *   rm -rf ~ / $HOME          (delete the user's home dir)
 *   dd of=/dev/sda            (overwrite a block device)
 *   mkfs.ext4 /dev/sda1       (format a filesystem)
 *   :(){ :|:& };:             (classic fork bomb)
 *   curl ... | sh             (run a downloaded script unverified)
 *
 * The classifier is intentionally narrow. We err toward false-negatives
 * (let through borderline-but-defensible commands) over false-positives
 * (block legitimate work and frustrate the user). Granular policy belongs
 * in the user's hooks.json or in the permission allow/deny patterns.
 *
 * Auto-approve bypasses the permission prompt but NOT this validator —
 * `block` here is final regardless of permission policy. That's the
 * point: a CI run with --auto-approve shouldn't be one bad model output
 * away from wiping the runner.
 */

export type ShellVerdict = "allow" | "warn" | "block";

export interface ShellValidationResult {
	verdict: ShellVerdict;
	/** Human-readable reason. Always set for warn / block. */
	reason?: string;
}

interface PatternRule {
	regex: RegExp;
	reason: string;
}

/**
 * Hard-block patterns. These return a verdict that auto-approve cannot
 * override. The list is intentionally short — only patterns we'd be
 * embarrassed to ship without catching. Anything that's only sometimes
 * destructive (e.g. `git push -f`) goes in WARN_PATTERNS instead.
 */
const BLOCK_PATTERNS: readonly PatternRule[] = [
	// `rm -rf /` and friends. The (?!\S) negative-lookahead lets us match
	// the literal "/" as the target without matching "/something" paths.
	{ regex: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(?!\S)/, reason: "recursive delete targeting the filesystem root" },
	{ regex: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\$HOME(?![A-Za-z0-9_])/, reason: "recursive delete targeting $HOME" },
	{
		regex: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+~(\s|$|\/(\s|$|[^/]))/,
		reason: "recursive delete targeting the home directory (~)",
	},
	{
		regex: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/\*(?!\S)/,
		reason: "recursive delete targeting every top-level directory (/*)",
	},

	// Fork bomb. The classic glyph soup.
	{ regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },

	// Writing raw bytes to a block device — almost always a mistake or
	// malicious. Covers `dd of=/dev/sda`, `> /dev/nvme0n1`, etc.
	{ regex: /\bdd\b[^\n;]*\bof=\/dev\/(sd|hd|nvme|vd|mmcblk)/, reason: "raw write to a block device" },
	{ regex: />\s*\/dev\/(sd|hd|nvme|vd|mmcblk)/, reason: "shell redirect to a block device" },

	// Format-the-disk commands. `mkfs.ext4`, `mkfs.xfs`, ...
	{ regex: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "formats a filesystem" },
];

/**
 * Soft-warn patterns. These don't get blocked outright — sometimes you
 * really do want to `sudo` something — but the verdict bubbles up so the
 * permission UI can render the warning and demand a deliberate click,
 * and downstream telemetry / hook layers can react.
 *
 * Auto-approve still allows these (it's already auto-approve), so the
 * line we draw is "needs a human to glance at, but isn't apocalyptic."
 */
const WARN_PATTERNS: readonly PatternRule[] = [
	{ regex: /\bsudo\b/, reason: "uses sudo (privilege escalation)" },
	{
		regex: /\bcurl\b[^\n;|]*\|\s*(sh|bash|zsh|sh\b)/,
		reason: "pipes a downloaded script straight into a shell — verify the source",
	},
	{
		regex: /\bwget\b[^\n;|]*\|\s*(sh|bash|zsh|sh\b)/,
		reason: "pipes a downloaded script straight into a shell — verify the source",
	},
	{
		regex: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(0?777|a\+w)\b/,
		reason: "world-writable permissions",
	},
	{ regex: /\bgit\s+push\b[^\n]*--force\b/, reason: "force-pushes — rewrites remote history" },
	{ regex: /\bgit\s+push\b[^\n]*-f\b/, reason: "force-pushes — rewrites remote history" },
	{
		regex: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\.\.\/){2,}/,
		reason: "recursive delete escaping multiple parent directories",
	},
];

export function validateShellCommand(command: string): ShellValidationResult {
	const normalized = command.trim();
	if (!normalized) return { verdict: "allow" };
	for (const rule of BLOCK_PATTERNS) {
		if (rule.regex.test(normalized)) return { verdict: "block", reason: rule.reason };
	}
	for (const rule of WARN_PATTERNS) {
		if (rule.regex.test(normalized)) return { verdict: "warn", reason: rule.reason };
	}
	return { verdict: "allow" };
}
