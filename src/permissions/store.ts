import { shellNeedsPermission } from "../tools/permission.js";

export type Decision = "allow" | "block";

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
]);

/**
 * Per-agent-instance permission store. Used by the agent's
 * beforeToolCall hook to decide whether to allow, prompt, or block.
 *
 * Trust state is in-memory and session-scoped — restarting the CLI
 * resets all per-tool/global trust. Persisting trust across sessions
 * lands in Phase 6 (config) so users can choose what to remember.
 */
export class PermissionStore {
	private trustAll = false;
	private readonly trustedTools = new Set<string>();
	private readonly queue: Array<{ request: PermissionRequest; resolve: (d: Decision) => void }> = [];
	private readonly listeners = new Set<(req: PermissionRequest | undefined) => void>();
	private counter = 0;

	async evaluate(toolName: string, args: unknown): Promise<Decision> {
		if (this.shouldAutoAllow(toolName, args)) return "allow";

		return new Promise((resolve) => {
			const request: PermissionRequest = {
				id: `perm-${++this.counter}`,
				tool: toolName,
				summary: summarize(toolName, args),
				detail: detailFor(toolName, args),
				risk: riskFor(toolName, args),
			};
			this.queue.push({ request, resolve });
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

		if (choice === "trust-tool") this.trustedTools.add(head.request.tool);
		else if (choice === "trust-all") this.trustAll = true;

		head.resolve(choice === "deny" ? "block" : "allow");
		this.queue.shift();
		this.notify();
	}

	/** Wipe trust state. Used by /reset and tests. */
	clear(): void {
		this.trustAll = false;
		this.trustedTools.clear();
	}

	private shouldAutoAllow(toolName: string, args: unknown): boolean {
		if (ALWAYS_ALLOWED.has(toolName)) return true;
		if (this.trustAll) return true;
		if (this.trustedTools.has(toolName)) return true;
		if (toolName === "shell") {
			const cmd = (args as { command?: string } | undefined)?.command;
			if (typeof cmd === "string" && !shellNeedsPermission(cmd)) return true;
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
