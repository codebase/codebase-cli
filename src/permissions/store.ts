import { shellNeedsPermission } from "../tools/permission.js";
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
	/** Optional multi-line detail (e.g. shell command, full diff). */
	detail?: string;
	/** Hint about how risky this is. UI may color accordingly. */
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
	private readonly matchAllow: (toolName: string, args: unknown) => boolean;
	private readonly matchDeny: (toolName: string, args: unknown) => boolean;
	private readonly autoApprove: boolean;

	constructor(options: PermissionStoreOptions = {}) {
		this.matchAllow = compileMatcher(options.allowPatterns ?? []);
		this.matchDeny = compileMatcher(options.denyPatterns ?? []);
		this.autoApprove = options.autoApprove ?? false;
	}

	async evaluate(toolName: string, args: unknown): Promise<Decision> {
		if (this.matchDeny(toolName, args)) return "block";
		if (this.shouldAutoAllow(toolName, args)) return "allow";
		if (this.matchAllow(toolName, args)) return "allow";
		if (this.autoApprove) return "allow";

		return new Promise((resolve) => {
			const request: PermissionRequest = {
				id: `perm-${++this.counter}`,
				tool: toolName,
				summary: summarize(toolName, args),
				detail: detailFor(toolName, args),
				risk: riskFor(toolName, args),
			};
			// For shell, capture the command prefix so a trust-tool response
			// trusts the command family (e.g. "git commit") rather than all
			// of shell.
			let shellPrefix: string | undefined;
			if (toolName === "shell") {
				const cmd = (args as { command?: string } | undefined)?.command;
				if (typeof cmd === "string") shellPrefix = commandPrefix(cmd) ?? undefined;
			}
			this.queue.push({ request, resolve, shellPrefix });
			this.notify();
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
		if (ALWAYS_ALLOWED.has(toolName)) return true;
		if (this.trustAll) return true;
		if (this.trustedTools.has(toolName)) return true;
		if (toolName === "shell") {
			const cmd = (args as { command?: string } | undefined)?.command;
			if (typeof cmd === "string") {
				if (!shellNeedsPermission(cmd)) return true;
				// Auto-allow if the command's prefix was trusted earlier.
				const prefix = commandPrefix(cmd);
				if (prefix && this.trustedShellPrefixes.has(prefix)) return true;
			}
		}
		// git_branch with no name (or just listing) is read-only.
		if (toolName === "git_branch") {
			const a = args as { name?: string } | undefined;
			if (!a?.name) return true;
		}
		return false;
	}

	private notify(): void {
		const cur = this.current();
		for (const listener of this.listeners) listener(cur);
	}
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

function riskFor(tool: string, args: unknown): "low" | "medium" | "high" {
	const a = (args ?? {}) as Record<string, unknown>;
	if (tool === "shell") {
		const cmd = stringOf(a.command);
		if (/\brm\s+-r/.test(cmd) || /\bgit\s+push/.test(cmd) || />\s*\/dev\//.test(cmd)) return "high";
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
