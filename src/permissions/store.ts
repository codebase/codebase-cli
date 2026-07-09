import { shellNeedsPermission } from "../tools/permission.js";
import { validateShellCommand } from "../tools/shell-validator.js";
import { commandPrefix } from "./command-prefix.js";

export type Decision = "allow" | "block";

/**
 * Convert a permission pattern's arg-glob portion into a regex.
 * `*` → `.*`, `?` → `.`, everything else escaped. Anchored.
 */
function compileGlob(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

/**
 * Pull the "primary string arg" from a tool-call args object. This
 * is the value users typically want to glob against — the shell
 * command, the file path, the URL, etc. Falls back to the JSON
 * stringification so unknown tools still match in some way.
 */
function primaryArgString(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
	switch (toolName) {
		case "shell":
			return pick("command") || pick("cmd");
		case "read_file":
		case "write_file":
		case "edit_file":
		case "multi_edit":
		case "notebook_edit":
			return pick("path") || pick("file_path");
		case "list_files":
			return pick("path");
		case "glob":
		case "grep":
			return pick("pattern");
		case "web_fetch":
			return pick("url");
		case "web_search":
			return pick("query");
		default:
			try {
				return JSON.stringify(args);
			} catch {
				return "";
			}
	}
}

/**
 * Compile a config-supplied list of `tool` or `tool:glob` patterns.
 * Returns a matcher closure; the closure returns true when the tool
 * call matches any pattern in the list.
 */
function compileMatcher(patterns: readonly string[]): (toolName: string, args: unknown) => boolean {
	if (patterns.length === 0) return () => false;
	const compiled = patterns.map((pattern) => {
		const colonIdx = pattern.indexOf(":");
		if (colonIdx < 0) {
			return { tool: pattern, regex: null as RegExp | null };
		}
		const tool = pattern.slice(0, colonIdx);
		const glob = pattern.slice(colonIdx + 1);
		return { tool, regex: compileGlob(glob) };
	});
	return (toolName: string, args: unknown) => {
		for (const { tool, regex } of compiled) {
			if (tool !== toolName) continue;
			if (!regex) return true;
			if (regex.test(primaryArgString(toolName, args))) return true;
		}
		return false;
	};
}

export type ResponseChoice = "allow-once" | "trust-tool" | "trust-all" | "deny";

export interface PermissionRequest {
	id: string;
	tool: string;
	/** One-line summary fit for a status line. */
	summary: string;
	/** Why this request needs a decision. */
	reason?: string;
	/** Optional multi-line detail (e.g. shell command, full diff). */
	detail?: string;
	/** Scope granted by a "trust tool" response. */
	trustScope?: string;
	/** Actionable approval guidance for UI/app clients to show below the request. */
	guidance?: readonly string[];
	/** Hint about how risky this is. UI may color accordingly. */
	risk: "low" | "medium" | "high";
}

export interface PermissionPreview {
	tool: string;
	summary: string;
	decision: "allow" | "prompt" | "block";
	source:
		| "deny-rule"
		| "shell-validator"
		| "session-trust"
		| "built-in-read-only"
		| "allow-rule"
		| "auto-approve"
		| "prompt";
	reason?: string;
	detail?: string;
	trustScope?: string;
	guidance?: readonly string[];
	risk: "low" | "medium" | "high";
}

/**
 * Tools that never need a permission prompt. The full read-only set
 * (audit-flagged "read-only allowlist" from permission.go) plus the task
 * read tools. Adding to this list requires careful thought: anything
 * that lands here can run without ever asking the user.
 */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
	"read_file",
	"list_files",
	"glob",
	"grep",
	"code_navigation",
	"web_fetch",
	"web_search",
	"git_status",
	"git_diff",
	"git_log",
	"dispatch_agent",
	"list_tasks",
	"get_task",
	"create_task",
	"update_task",
	// ask_user is a question, not a mutation — the user-query UI gates the
	// actual interaction so a permission prompt on top is redundant.
	"ask_user",
	// Memory tools are user-context, not destructive code edits — auto-allow.
	"save_memory",
	"read_memory",
	// `config` is read-only.
	"config",
	// present_copy only surfaces a click-to-copy box in the UI — no fs,
	// shell, or network. Prompting for it would be pure friction.
	"present_copy",
	// MCP resource reads are read-only fetches from already-trusted servers.
	"list_mcp_resources",
	"read_mcp_resource",
]);

export interface PermissionStoreOptions {
	/**
	 * Persistent allow patterns from the layered config. Each is either
	 * a bare tool name or `tool:<arg-glob>` — see Config.permissions in
	 * `src/config/types.ts`.
	 */
	allowPatterns?: readonly string[];
	/**
	 * Persistent deny patterns. Take priority over allows AND the
	 * built-in always-allowed set, so a user can deny e.g. `shell:rm *`
	 * without touching the read-only allowlist.
	 */
	denyPatterns?: readonly string[];
	/**
	 * When true, every tool call that would otherwise prompt the user
	 * gets auto-approved instead. Used by headless / CI / bench runs
	 * where there's no human at the terminal to answer the prompt and
	 * the alternative is to hang forever.
	 *
	 * Deny patterns still apply and still block. The user is opting
	 * into "allow everything except deny", not "allow literally
	 * everything".
	 */
	autoApprove?: boolean;
}

/**
 * Per-agent-instance permission store. Used by the agent's
 * beforeToolCall hook to decide whether to allow, prompt, or block.
 *
 * Decision order, highest priority first:
 *   1. config-supplied deny patterns       → block immediately
 *   2. session-scoped "trust-all" response → allow
 *   3. session-scoped "trust-tool" response → allow for that tool
 *   4. built-in ALWAYS_ALLOWED read-only set → allow
 *   5. config-supplied allow patterns      → allow
 *   6. shell-/git-branch-specific read heuristics → allow
 *   7. otherwise → prompt the user
 *
 * Trust state from interactive responses is in-memory (session-only).
 * Persisting it across sessions is what the config layer is for —
 * users can promote a session-scoped trust to a config entry by
 * editing ~/.codebase/config.json.
 */
export class PermissionStore {
	private trustAll = false;
	private readonly trustedTools = new Set<string>();
	/** Trusted shell command prefixes (e.g. "git commit") from a trust-tool
	 * response to a shell prompt. Scopes trust to the command family rather
	 * than all of shell — trusting one `git commit` doesn't trust `rm`. */
	private readonly trustedShellPrefixes = new Set<string>();
	private readonly queue: Array<{
		request: PermissionRequest;
		resolve: (d: Decision) => void;
		/** Command prefix for a shell prompt, used to scope trust-tool. */
		shellPrefix?: string;
	}> = [];
	private readonly listeners = new Set<(req: PermissionRequest | undefined) => void>();
	private counter = 0;
	private matchAllow: (toolName: string, args: unknown) => boolean;
	private matchDeny: (toolName: string, args: unknown) => boolean;
	private readonly autoApprove: boolean;

	constructor(options: PermissionStoreOptions = {}) {
		this.matchAllow = compileMatcher(options.allowPatterns ?? []);
		this.matchDeny = compileMatcher(options.denyPatterns ?? []);
		this.autoApprove = options.autoApprove ?? false;
	}

	/** Recompile the allow/deny matchers from new patterns (e.g. after /permissions edits). */
	setRules(allowPatterns: readonly string[], denyPatterns: readonly string[]): void {
		this.matchAllow = compileMatcher(allowPatterns);
		this.matchDeny = compileMatcher(denyPatterns);
	}

	/** Session-scoped trusts granted via the permission prompt, for display. */
	listTrusted(): { tools: string[]; shellPrefixes: string[] } {
		return {
			tools: [...this.trustedTools].sort(),
			shellPrefixes: [...this.trustedShellPrefixes].sort(),
		};
	}

	async evaluate(toolName: string, args: unknown): Promise<Decision> {
		if (this.matchDeny(toolName, args)) return "block";
		if (this.shouldAutoAllow(toolName, args)) return "allow";
		if (this.matchAllow(toolName, args)) return "allow";
		if (this.autoApprove) return "allow";

		return new Promise((resolve) => {
			let shellPrefix: string | undefined;
			if (toolName === "shell") {
				const cmd = (args as { command?: string } | undefined)?.command;
				if (typeof cmd === "string") shellPrefix = commandPrefix(cmd) ?? undefined;
			}
			const request: PermissionRequest = {
				id: `perm-${++this.counter}`,
				tool: toolName,
				summary: summarize(toolName, args),
				reason: reasonFor(toolName, args),
				detail: detailFor(toolName, args),
				trustScope: trustScopeFor(toolName, shellPrefix),
				guidance: guidanceFor(toolName, args, shellPrefix),
				risk: riskFor(toolName, args),
			};
			// For shell, capture the command prefix so a trust-tool response
			// trusts the command family (e.g. "git commit") rather than all
			// of shell.
			this.queue.push({ request, resolve, shellPrefix });
			this.notify();
		});
	}

	/** Read-only preview of the same policy path evaluate() uses, without queuing a prompt. */
	preview(toolName: string, args: unknown): PermissionPreview {
		let shellPrefix: string | undefined;
		if (toolName === "shell") {
			const cmd = (args as { command?: string } | undefined)?.command;
			if (typeof cmd === "string") shellPrefix = commandPrefix(cmd) ?? undefined;
			const verdict = validateShellCommand(typeof cmd === "string" ? cmd : "");
			if (verdict.verdict === "block") {
				return previewFor(toolName, args, shellPrefix, {
					decision: "block",
					source: "shell-validator",
					risk: "high",
					reason: reasonFor(toolName, args),
					guidance: guidanceFor(toolName, args, shellPrefix),
				});
			}
		}

		if (this.matchDeny(toolName, args)) {
			return previewFor(toolName, args, shellPrefix, {
				decision: "block",
				source: "deny-rule",
				risk: riskFor(toolName, args),
				reason: "Blocked by a persisted deny rule.",
			});
		}

		const autoSource = this.autoAllowSource(toolName, args);
		if (autoSource) {
			return previewFor(toolName, args, shellPrefix, {
				decision: "allow",
				source: autoSource,
				risk: autoSource === "built-in-read-only" ? "low" : riskFor(toolName, args),
				reason: autoSourceReason(autoSource),
			});
		}

		if (this.matchAllow(toolName, args)) {
			return previewFor(toolName, args, shellPrefix, {
				decision: "allow",
				source: "allow-rule",
				risk: riskFor(toolName, args),
				reason: "Allowed by a persisted allow rule.",
			});
		}

		if (this.autoApprove) {
			return previewFor(toolName, args, shellPrefix, {
				decision: "allow",
				source: "auto-approve",
				risk: riskFor(toolName, args),
				reason: "Allowed because auto-approve is enabled; deny rules and shell hard-blocks still win.",
			});
		}

		return previewFor(toolName, args, shellPrefix, {
			decision: "prompt",
			source: "prompt",
			risk: riskFor(toolName, args),
			reason: reasonFor(toolName, args),
			guidance: guidanceFor(toolName, args, shellPrefix),
		});
	}

	current(): PermissionRequest | undefined {
		return this.queue[0]?.request;
	}

	subscribe(listener: (req: PermissionRequest | undefined) => void): () => void {
		this.listeners.add(listener);
		listener(this.current());
		return () => {
			this.listeners.delete(listener);
		};
	}

	respond(id: string, choice: ResponseChoice): void {
		const head = this.queue[0];
		if (!head || head.request.id !== id) return;

		if (choice === "trust-tool") {
			// Shell trust is scoped to the command prefix when we have one,
			// so "trust" on a `git commit` prompt auto-allows future
			// `git commit …` calls but NOT every shell command. Falls back to
			// whole-tool trust when no prefix could be extracted.
			if (head.request.tool === "shell" && head.shellPrefix) {
				this.trustedShellPrefixes.add(head.shellPrefix);
			} else {
				this.trustedTools.add(head.request.tool);
			}
		} else if (choice === "trust-all") {
			this.trustAll = true;
		}

		head.resolve(choice === "deny" ? "block" : "allow");
		this.queue.shift();
		this.notify();
	}

	/** Wipe trust state. Used by /reset and tests. */
	clear(): void {
		this.trustAll = false;
		this.trustedTools.clear();
		this.trustedShellPrefixes.clear();
	}

	private shouldAutoAllow(toolName: string, args: unknown): boolean {
		return this.autoAllowSource(toolName, args) !== null;
	}

	private autoAllowSource(toolName: string, args: unknown): PermissionPreview["source"] | null {
		if (ALWAYS_ALLOWED.has(toolName)) return "built-in-read-only";
		if (this.trustAll) return "session-trust";
		if (this.trustedTools.has(toolName)) return "session-trust";
		if (toolName === "shell") {
			const cmd = (args as { command?: string } | undefined)?.command;
			if (typeof cmd === "string") {
				if (!shellNeedsPermission(cmd)) return "built-in-read-only";
				// Auto-allow if the command's prefix was trusted earlier.
				const prefix = commandPrefix(cmd);
				if (prefix && this.trustedShellPrefixes.has(prefix)) return "session-trust";
			}
		}
		// git_branch with no name (or just listing) is read-only.
		if (toolName === "git_branch") {
			const a = args as { name?: string } | undefined;
			if (!a?.name) return "built-in-read-only";
		}
		return null;
	}

	private notify(): void {
		const cur = this.current();
		for (const listener of this.listeners) listener(cur);
	}
}

function previewFor(
	tool: string,
	args: unknown,
	shellPrefix: string | undefined,
	decision: Pick<PermissionPreview, "decision" | "source" | "risk" | "reason" | "guidance">,
): PermissionPreview {
	return {
		tool,
		summary: summarize(tool, args),
		detail: detailFor(tool, args),
		trustScope: trustScopeFor(tool, shellPrefix),
		...decision,
	};
}

function autoSourceReason(source: PermissionPreview["source"]): string | undefined {
	if (source === "built-in-read-only") return "Allowed by the built-in read-only policy.";
	if (source === "session-trust") return "Allowed by session trust.";
	return undefined;
}

/** Tool-specific human-readable summary line. */
function summarize(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (tool) {
		case "shell":
			return `Run shell: ${truncate(stringOf(a.command), 80)}`;
		case "write_file":
			return `Create or overwrite: ${stringOf(a.path)}`;
		case "edit_file":
			return `Edit: ${stringOf(a.path)}`;
		case "multi_edit":
			return `Multi-edit: ${stringOf(a.path)}`;
		case "notebook_edit":
			return `${stringOf(a.operation) || "edit"} cell ${a.cell_index ?? ""} in ${stringOf(a.path)}`.trim();
		case "git_commit":
			return `git commit: ${truncate(stringOf(a.message), 80)}`;
		case "git_branch": {
			if (a.create) return `Create branch: ${stringOf(a.name)}`;
			if (a.name) return `Switch to branch: ${stringOf(a.name)}`;
			return "List branches";
		}
		case "enter_worktree":
			return `Open worktree: ${stringOf(a.path)}`;
		case "exit_worktree":
			return "Exit worktree";
		case "ask_user":
			return `Ask user: ${truncate(stringOf(a.question), 80)}`;
		default:
			return `Run ${tool}`;
	}
}

/** Multi-line detail for the prompt UI to expand. */
function detailFor(tool: string, args: unknown): string | undefined {
	const a = (args ?? {}) as Record<string, unknown>;
	if (tool === "shell" && typeof a.command === "string") return a.command;
	if (tool === "git_commit" && typeof a.message === "string") return a.message;
	return undefined;
}

function reasonFor(tool: string, args: unknown): string | undefined {
	const a = (args ?? {}) as Record<string, unknown>;
	if (tool === "shell") {
		const cmd = stringOf(a.command);
		const verdict = validateShellCommand(cmd);
		if (verdict.verdict === "block" && verdict.reason) {
			return `High risk: shell validator will hard-block this command: ${verdict.reason}.`;
		}
		if (verdict.verdict === "warn" && verdict.reason) {
			return `High risk: shell validator warning: ${verdict.reason}.`;
		}
		return shellRiskReason(cmd);
	}
	if (tool === "write_file") return "This will create or overwrite a file in the workspace.";
	if (tool === "edit_file" || tool === "multi_edit" || tool === "notebook_edit") {
		return "This will modify files in the workspace.";
	}
	if (tool === "git_commit") return "This will create a git commit.";
	if (tool === "git_branch") return "This will change git branch state.";
	if (tool === "enter_worktree" || tool === "exit_worktree") return "This will change the active worktree.";
	return undefined;
}

function guidanceFor(tool: string, args: unknown, shellPrefix?: string): string[] | undefined {
	if (tool !== "shell") return undefined;
	const cmd = stringOf((args as Record<string, unknown> | undefined)?.command);
	const verdict = validateShellCommand(cmd);
	const lines: string[] = [];

	if (verdict.verdict === "block") {
		lines.push("No allow rule is offered for hard-blocked commands; rewrite it to target a safe path.");
		return lines;
	}

	if (verdict.verdict === "warn" && verdict.reason) {
		const advice = warningAdvice(verdict.reason);
		if (advice) lines.push(`Safer path: ${advice}`);
	}

	if (shellPrefix && shellNeedsPermission(cmd)) {
		const scope = `shell:${shellPrefix}*`;
		lines.push(`Trust tool grants ${scope} for this session only.`);
		const exact = exactShellPattern(cmd);
		if (exact) lines.push(`Persist exact allow: /permissions allow ${exact}`);
		lines.push(`Persist family allow: /permissions allow ${scope}`);
		lines.push(`Persist family deny: /permissions deny ${scope}`);
	} else if (shellNeedsPermission(cmd)) {
		lines.push("Use allow-once; no stable command prefix was detected.");
	}
	return lines.length > 0 ? lines : undefined;
}

function shellRiskReason(cmd: string): string {
	if (/\bnpm\s+(install|i|add|ci)\b/.test(cmd) || /\b(pnpm|yarn|bun)\s+(install|add)\b/.test(cmd)) {
		return "Medium risk: package installs can change dependencies, lockfiles, and run lifecycle scripts.";
	}
	if (/\bpip\s+install\b/.test(cmd) || /\buv\s+(pip\s+)?install\b/.test(cmd)) {
		return "Medium risk: package installs can change the active Python environment.";
	}
	if (/\bgit\s+commit\b/.test(cmd)) {
		return "Medium risk: this creates local git history and should match the intended diff.";
	}
	if (/\bgit\s+push\b/.test(cmd)) {
		return "High risk: this sends commits to a remote repository.";
	}
	if (/\brm\b/.test(cmd)) {
		return "High risk: delete commands can permanently remove workspace files.";
	}
	if (/\bchmod\b/.test(cmd) || /\bchown\b/.test(cmd)) {
		return "Medium risk: permission or ownership changes can make files executable, unreadable, or broadly writable.";
	}
	return "Medium risk: this shell command is not in the read-only allowlist, so it needs approval before running.";
}

function exactShellPattern(cmd: string): string | null {
	const trimmed = cmd.trim().replace(/\s+/g, " ");
	if (!trimmed || trimmed.length > 160) return null;
	// Permission globs do not have an escape syntax. If the command already
	// contains glob metacharacters, an "exact" rule would silently broaden.
	if (/[*?]/.test(trimmed)) return null;
	return `shell:${trimmed}`;
}

function warningAdvice(reason: string): string | null {
	if (reason.includes("downloaded script"))
		return "download to a file, inspect it, then run the local script explicitly.";
	if (reason.includes("sudo"))
		return "prefer a non-sudo command, or keep this as allow-once unless elevation is truly needed.";
	if (reason.includes("force-pushes")) return "push without force, or confirm branch/protection before allowing once.";
	if (reason.includes("world-writable")) return "prefer narrower permissions like 755, 644, or targeted +x.";
	if (reason.includes("parent directories")) return "target a project-relative directory explicitly.";
	return null;
}

function trustScopeFor(tool: string, shellPrefix?: string): string {
	if (tool === "shell" && shellPrefix) return `shell:${shellPrefix}*`;
	return tool;
}

function riskFor(tool: string, args: unknown): "low" | "medium" | "high" {
	const a = (args ?? {}) as Record<string, unknown>;
	if (tool === "shell") {
		const cmd = stringOf(a.command);
		const verdict = validateShellCommand(cmd);
		if (verdict.verdict === "warn" || verdict.verdict === "block") return "high";
		if (/\brm\b/.test(cmd) || /\bgit\s+push/.test(cmd) || />\s*\/dev\//.test(cmd)) return "high";
		return "medium";
	}
	if (tool === "git_commit" || tool === "git_branch") return "medium";
	return "medium";
}

function stringOf(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
