import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAskUser } from "./ask-user.js";
import { capToolResult } from "./cap-tool-result.js";
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
import { createMcpResourceTools } from "./mcp-resources.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMonitor } from "./monitor.js";
import { createMonitorStop } from "./monitor-stop.js";
import { createMultiEdit } from "./multi-edit.js";
import { createNotebookEdit } from "./notebook-edit.js";
import { createPlanModeTools } from "./plan-mode.js";
import { createPresentCopy } from "./present-copy.js";
import { createReadFile } from "./read-file.js";
import { createShell } from "./shell.js";
import { createShellKill } from "./shell-kill.js";
import { createShellOutput } from "./shell-output.js";
import { createSshExec } from "./ssh-exec.js";
import { createTaskTools } from "./tasks.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";
import { createWebSearch } from "./web-search.js";
import { withCheckpoint } from "./with-checkpoint.js";
import { createWriteFile } from "./write-file.js";

/**
 * Returns every built-in tool, configured against the given context.
 * Add new tools by importing their factory and appending it here.
 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
	const tools = [
		createReadFile(ctx),
		createEditFile(ctx),
		createMultiEdit(ctx),
		createNotebookEdit(ctx),
		createWriteFile(ctx),
		createShell(ctx),
		createShellOutput(ctx),
		createShellKill(ctx),
		createMonitor(ctx),
		createMonitorStop(ctx),
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
		createPresentCopy(),
		...createPlanModeTools(ctx),
		createWebFetch(ctx),
		createWebSearch(ctx),
		createDispatchAgent(ctx),
		...createTaskTools(ctx),
		...createMemoryTools(ctx),
		...createMcpResourceTools(ctx),
		createConfig(ctx),
	];
	// Two cross-cutting wrappers:
	//  - withCheckpoint snapshots a file's pre-image before any mutating
	//    tool touches it, so /rewind can restore prior states.
	//  - capToolResult persists an oversized result to disk and replaces
	//    it in-context with a preview + path, protecting the context
	//    window from an unbounded grep / read_file / web_fetch.
	return tools.map((t) => capToolResult(withCheckpoint(t, ctx)));
}
