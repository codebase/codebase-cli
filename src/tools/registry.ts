import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createEditFile } from "./edit-file.js";
import { createReadFile } from "./read-file.js";
import type { ToolContext } from "./types.js";
import { createWriteFile } from "./write-file.js";

/**
 * Returns every built-in tool, configured against the given context.
 * Phase 2 commits append factories to this list one by one.
 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
	return [createReadFile(ctx), createEditFile(ctx), createWriteFile(ctx)];
}
