import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAskUser } from "./ask-user.js";
import { createConfig } from "./config.js";
import { createDispatchAgent } from "./dispatch-agent.js";
import { createEditFile } from "./edit-file.js";
import { createGitBranch } from "./git/branch.js";
import { createGitCommit } from "./git/commit.js";
import { createGitDiff } from "./git/diff.js";
import { createGitLog } from "./git/log.js";
import { createGitStatus } from "./git/status.js";
import { createEnterWorktree, createExitWorktree } from "./git/worktree.js";
import { createGlob } from "./glob.js";
import { createGrep } from "./grep.js";
import { createListFiles } from "./list-files.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMultiEdit } from "./multi-edit.js";
import { createNotebookEdit } from "./notebook-edit.js";
import { createPlanModeTools } from "./plan-mode.js";
import { createReadFile } from "./read-file.js";
import { createShell } from "./shell.js";
import { createShellKill } from "./shell-kill.js";
import { createShellOutput } from "./shell-output.js";
import { createSshExec } from "./ssh-exec.js";
import { createTaskTools } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";
import { createWriteFile } from "./write-file.js";

/**
 * Returns every built-in tool, configured against the given context.
 * Add new tools by importing their factory and appending it here.
 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
	return [
		createReadFile(ctx),
		createEditFile(ctx),
		createMultiEdit(ctx),
		createNotebookEdit(ctx),
		createWriteFile(ctx),
		createShell(ctx),
		createShellOutput(ctx),
		createShellKill(ctx),
		createSshExec(ctx),
		createListFiles(ctx),
		createGlob(ctx),
		createGrep(ctx),
		createGitStatus(ctx),
		createGitDiff(ctx),
		createGitLog(ctx),
		createGitCommit(ctx),
		createGitBranch(ctx),
		createEnterWorktree(ctx),
		createExitWorktree(ctx),
		createAskUser(ctx),
		...createPlanModeTools(ctx),
		createWebFetch(ctx),
		createWebSearch(ctx),
		createDispatchAgent(ctx),
		...createTaskTools(ctx),
		...createMemoryTools(ctx),
		createConfig(ctx),
	];
}
