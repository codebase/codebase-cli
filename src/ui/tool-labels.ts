import { displayPath } from "./paths.js";

/**
 * Render a tool call as a human-friendly action label: present-tense
 * verb + the salient argument (file path, command, URL, search query,
 * etc.) instead of the raw `toolName(k1=v1, k2=v2)` shape. Falls back
 * to the verbose form for tools we don't have a special case for.
 */
export function toolActionLabel(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
	const path = displayPath(str("path") || str("file_path"));

	switch (name) {
		case "read_file":
			return `Reading ${path}`;
		case "write_file":
			return `Writing ${path}`;
		case "edit_file":
			return `Editing ${path}`;
		case "multi_edit":
			return `Editing ${path}`;
		case "notebook_edit":
			return `Editing notebook ${path}`;
		case "list_files":
			return `Listing ${path || "."}`;
		case "glob":
			return `Searching ${str("pattern")}`;
		case "grep":
			return `Searching for "${str("pattern")}"`;
		case "shell":
			return `Running: ${truncate(str("command") || str("cmd"), 60)}`;
		case "web_fetch":
			return `Fetching ${str("url")}`;
		case "web_search":
			return `Searching: ${truncate(str("query"), 60)}`;
		case "git_status":
			return "git status";
		case "git_diff":
			return `git diff${str("target") ? ` ${str("target")}` : ""}`;
		case "git_log":
			return "git log";
		case "git_commit":
			return `git commit: ${truncate(str("message"), 50)}`;
		case "git_branch":
			return str("name") ? `git branch ${str("name")}` : "git branches";
		case "enter_worktree":
			return `Entering worktree ${str("branch") || str("name")}`;
		case "exit_worktree":
			return "Leaving worktree";
		case "enter_plan_mode":
			return "Entering plan mode";
		case "exit_plan_mode":
			return "Exiting plan mode";
		case "dispatch_agent":
			return `Dispatching subagent: ${truncate(str("task"), 60)}`;
		case "ask_user":
			return `Asking: ${truncate(str("question"), 60)}`;
		case "create_task":
			return `Task: ${truncate(str("subject"), 60)}`;
		case "update_task":
			return `Updating task ${str("taskId")}`;
		case "list_tasks":
			return "Listing tasks";
		case "get_task":
			return `Reading task ${str("taskId")}`;
		case "save_memory":
			return `Saving memory: ${str("name") || str("type")}`;
		case "read_memory":
			return str("filename") ? `Reading memory ${str("filename")}` : "Reading MEMORY.md";
		case "config":
			return str("path") ? `config(${str("path")})` : "Reading config";
		default:
			return `${name}(${summarizeArgs(args)})`;
	}
}

/**
 * Past-tense action label, used when a tool has finished. Same shape
 * as `toolActionLabel` but with the verbs swapped to past tense.
 */
export function toolActionPast(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
	const path = displayPath(str("path") || str("file_path"));

	switch (name) {
		case "read_file":
			return `Read ${path}`;
		case "write_file":
			return `Wrote ${path}`;
		case "edit_file":
			return `Edited ${path}`;
		case "multi_edit":
			return `Edited ${path}`;
		case "notebook_edit":
			return `Edited notebook ${path}`;
		case "list_files":
			return `Listed ${path || "."}`;
		case "glob":
			return `Searched ${str("pattern")}`;
		case "grep":
			return `Searched for "${str("pattern")}"`;
		case "shell":
			return `Ran: ${truncate(str("command") || str("cmd"), 60)}`;
		case "web_fetch":
			return `Fetched ${str("url")}`;
		case "web_search":
			return `Searched: ${truncate(str("query"), 60)}`;
		case "git_status":
			return "git status";
		case "git_diff":
			return `git diff${str("target") ? ` ${str("target")}` : ""}`;
		case "git_log":
			return "git log";
		case "git_commit":
			return `git commit: ${truncate(str("message"), 50)}`;
		case "git_branch":
			return str("name") ? `git branch ${str("name")}` : "git branches";
		case "enter_worktree":
			return `Entered worktree ${str("branch") || str("name")}`;
		case "exit_worktree":
			return "Left worktree";
		case "enter_plan_mode":
			return "Entered plan mode";
		case "exit_plan_mode":
			return "Exited plan mode";
		case "dispatch_agent":
			return `Subagent: ${truncate(str("task"), 60)}`;
		case "ask_user":
			return `Asked: ${truncate(str("question"), 60)}`;
		case "create_task":
			return `Created task: ${truncate(str("subject"), 60)}`;
		case "update_task":
			return `Updated task ${str("taskId")}`;
		case "list_tasks":
			return "Listed tasks";
		case "get_task":
			return `Read task ${str("taskId")}`;
		case "save_memory":
			return `Saved memory: ${str("name") || str("type")}`;
		case "read_memory":
			return str("filename") ? `Read memory ${str("filename")}` : "Read MEMORY.md";
		case "config":
			return str("path") ? `config(${str("path")})` : "Read config";
		default:
			return `${name}(${summarizeArgs(args)})`;
	}
}

/**
 * Tool calls that are pure reads — runs of these collapse into a single
 * "Read N files" line. Keep the set tight: anything that mutates state,
 * runs shell, or has a meaningful argument shape (grep query, fetch
 * URL) reads weird when collapsed and stays per-row.
 *
 * Shared by both render paths (ui/ and ui-pi/) so the collapse rule is
 * a single source of truth.
 */
export const COLLAPSIBLE_READ_TOOLS: ReadonlySet<string> = new Set(["read_file"]);

/** Verb used when describing a *running* read-style tool in collapse rows. */
export function presentVerbForReadTool(name: string): string {
	if (name === "read_file") return "Reading";
	if (name === "list_files") return "Listing";
	if (name === "glob") return "Searching";
	if (name === "grep") return "Grepping";
	return "Running";
}

/** Verb used when describing a *finished* read-style tool in collapse rows. */
export function pastVerbForReadTool(name: string): string {
	if (name === "read_file") return "Read";
	if (name === "list_files") return "Listed";
	if (name === "glob") return "Searched";
	if (name === "grep") return "Grepped";
	return "Ran";
}

/** Plural noun used to describe N items of a given read tool. */
export function nounForReadTool(name: string, count: number): string {
	if (name === "read_file") return count === 1 ? "file" : "files";
	if (name === "list_files") return count === 1 ? "directory" : "directories";
	return count === 1 ? "call" : "calls";
}

export function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
	return entries
		.map(([k, v]) => {
			const s = typeof v === "string" ? `"${v.slice(0, 30)}"` : String(v);
			return `${k}=${s}`;
		})
		.join(", ");
}
