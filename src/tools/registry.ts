import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createEditFile } from "./edit-file.js";
import { createGitDiff } from "./git/diff.js";
import { createGitLog } from "./git/log.js";
import { createGitStatus } from "./git/status.js";
import { createGlob } from "./glob.js";
import { createGrep } from "./grep.js";
import { createListFiles } from "./list-files.js";
import { createMultiEdit } from "./multi-edit.js";
import { createReadFile } from "./read-file.js";
import { createShell } from "./shell.js";
import { createTaskTools } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";
import { createWriteFile } from "./write-file.js";

/**
 * Returns every built-in tool, configured against the given context.
 * Phase 2 commits append factories to this list one by one.
 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
	return [
		createReadFile(ctx),
		createEditFile(ctx),
		createMultiEdit(ctx),
		createWriteFile(ctx),
		createShell(ctx),
		createListFiles(ctx),
		createGlob(ctx),
		createGrep(ctx),
		createGitStatus(ctx),
		createGitDiff(ctx),
		createGitLog(ctx),
		createWebFetch(ctx),
		createWebSearch(ctx),
		...createTaskTools(ctx),
	];
}
