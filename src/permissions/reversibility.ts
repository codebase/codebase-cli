import { DANGEROUS_PATTERNS, shellNeedsPermission } from "../tools/permission.js";
import { commandPrefix } from "./command-prefix.js";

/**
 * Reversibility classification for a single tool call. This is the safety
 * core of autonomous "director" mode: it decides whether an action can be
 * auto-run unattended (`reversible`), must be escalated to the human
 * (`irreversible`), or is ambiguous enough that we default to escalating
 * (`unknown`).
 *
 * It replaces the old shell-regex `isDestructive`. Two deliberate ideas:
 *
 *  1. **Reversibility, not "danger".** A `write_file` that clobbers a file
 *     is *reversible* — `withCheckpoint` snapshots the pre-image and
 *     `/rewind` restores it. The old regex flagged file writes as risky
 *     and waved through a `git push`; this gets both right.
 *  2. **`unknown` is first-class and conservative.** Anything we can't
 *     confidently call reversible routes to `unknown`, whose caller-side
 *     default is to escalate. We never need to perfectly classify the long
 *     tail — only to never mislabel an irrecoverable action as reversible.
 *
 * Pure and dependency-free (beyond the existing permission helpers) so it's
 * exhaustively testable and reusable by the headless gate.
 */

export type Reversibility = "reversible" | "irreversible" | "unknown";

export interface Verdict {
	rev: Reversibility;
	risk: "low" | "medium" | "high";
	/** One line explaining the call, for the escalation message + activity log. */
	reason: string;
}

/** No lasting effect, or a read — always safe to run unattended. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"list_files",
	"glob",
	"grep",
	"web_fetch",
	"web_search",
	"git_status",
	"git_diff",
	"git_log",
	"list_tasks",
	"get_task",
	"read_memory",
	"config",
	"present_copy",
	"list_mcp_resources",
	"read_mcp_resource",
	"shell_output",
	"enter_plan_mode",
	"exit_plan_mode",
	// A question to the human, not a mutation. (Director mode intercepts this
	// upstream as an uncertainty escalation; here it's simply not destructive.)
	"ask_user",
]);

/** File mutations whose pre-image is snapshotted — `/rewind` makes them reversible. */
const CHECKPOINTED_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);

/** Mutations confined to local session / git state — undoable, never escape the box. */
const LOCAL_REVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
	"create_task",
	"update_task",
	"save_memory",
	"monitor",
	"monitor_stop",
	"shell_kill",
	"git_commit", // local; am/reset can undo
	"git_branch", // local ref
	"enter_worktree",
	"exit_worktree",
	// The dispatched worker's OWN tool calls each pass back through this gate,
	// so spawning it is not itself an irreversible act.
	"dispatch_agent",
]);

/** Tools that always reach outside this machine in a way nothing here can undo. */
const ALWAYS_IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
	"ssh_exec",
	// The outbound director message itself: you can't unsend an email, so the
	// act of contacting a human is gated like any other irreversible op.
	"channel_send",
]);

/** Shell command families with no undo. Keyed on commandPrefix(). */
const IRREVERSIBLE_SHELL_PREFIXES: ReadonlySet<string> = new Set([
	"git push",
	"git reset", // --hard discards work
	"rm",
	"dd",
	"mkfs",
	"shutdown",
	"reboot",
	"kubectl delete",
	"kubectl apply",
	"terraform apply",
	"terraform destroy",
	"helm delete",
	"helm uninstall",
	"helm upgrade",
	"npm publish",
	"yarn publish",
	"pnpm publish",
	"bun publish",
	"docker push",
]);

/** Mutating shell families that only change local/git state — undoable. */
const REVERSIBLE_SHELL_PREFIXES: ReadonlySet<string> = new Set([
	"git commit",
	"git add",
	"git checkout",
	"git switch",
	"git stash",
	"git merge",
	"git rebase",
	"git cherry-pick",
	"git revert",
	"git restore",
	"git tag",
	"mkdir",
	"touch",
	"npm install",
	"npm ci",
	"pnpm install",
	"yarn install",
	"bun install",
	"pip install",
	"pip3 install",
	"make",
	"cargo build",
	"cargo test",
]);

const MCP_READ_VERB = /(?:^|_)(?:get|list|read|search|fetch|query|describe|show|find|count)(?:_|$)/;
const MCP_WRITE_VERB =
	/(?:^|_)(?:delete|drop|remove|destroy|send|post|put|patch|create|update|insert|upsert|charge|pay|transfer|deploy|publish|write|set|cancel|approve)(?:_|$)/;

/** Classify one tool call. Pure — no I/O, no config. */
export function classifyReversibility(tool: string, args: unknown): Verdict {
	if (READ_ONLY_TOOLS.has(tool)) return v("reversible", "low", `${tool} is read-only`);
	if (CHECKPOINTED_TOOLS.has(tool))
		return v("reversible", "medium", `${tool} is checkpointed — /rewind can restore it`);
	if (LOCAL_REVERSIBLE_TOOLS.has(tool)) return v("reversible", "low", `${tool} only touches local session/git state`);
	if (ALWAYS_IRREVERSIBLE_TOOLS.has(tool))
		return v("irreversible", "high", `${tool} acts outside this machine — no undo`);
	if (tool === "shell") return classifyShell(stringOf((args as { command?: unknown } | undefined)?.command));
	if (tool.startsWith("mcp__")) return classifyMcp(tool);
	return v("unknown", "medium", `no reversibility rule for ${tool}`);
}

/** Top-level segments of a compound command (same separators commandPrefix splits on). */
function shellSegments(cmd: string): string[] {
	return cmd
		.split(/&&|\|\||;|\||\n/)
		.map((seg) => seg.trim())
		.filter(Boolean);
}

function classifyShell(rawCommand: string): Verdict {
	const cmd = rawCommand.trim();
	if (!cmd) return v("unknown", "medium", "empty shell command");
	if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) {
		return v("irreversible", "high", "matches a hard-block destructive shell pattern");
	}
	// Classify EVERY segment of a compound command, not just the leading one.
	// `git commit && git push` must be irreversible: the reversible `git commit`
	// prefix must never shadow the irreversible `git push` tail. Any irreversible
	// segment poisons the whole command.
	const prefixes = shellSegments(cmd).map((seg) => commandPrefix(seg));
	const irreversible = prefixes.find((p) => p !== null && IRREVERSIBLE_SHELL_PREFIXES.has(p));
	if (irreversible) return v("irreversible", "high", `\`${irreversible}\` can't be undone`);
	// shellNeedsPermission is the existing single source of truth for "this
	// command is read-only" — reuse it rather than re-deriving the allowlist.
	if (!shellNeedsPermission(cmd)) return v("reversible", "low", "read-only shell command");
	// Reversible only if EVERY segment is a known local/git-state mutation; one
	// unclassified segment (e.g. a stray `curl -X POST`) routes to unknown → escalate.
	if (prefixes.length > 0 && prefixes.every((p) => p !== null && REVERSIBLE_SHELL_PREFIXES.has(p))) {
		return v("reversible", "low", "only local/git-state changes");
	}
	const lead = prefixes[0] ?? null;
	return v("unknown", "medium", lead ? `unclassified shell command \`${lead}\`` : "unclassified shell command");
}

function classifyMcp(tool: string): Verdict {
	const action = (tool.split("__").pop() ?? "").toLowerCase();
	if (MCP_READ_VERB.test(action)) return v("reversible", "low", `${tool} reads from an MCP server`);
	if (MCP_WRITE_VERB.test(action)) return v("irreversible", "high", `${tool} mutates external state via MCP`);
	return v("unknown", "medium", `unclassified MCP tool ${tool}`);
}

function v(rev: Reversibility, risk: Verdict["risk"], reason: string): Verdict {
	return { rev, risk, reason };
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}
