import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./types.js";

/**
 * Returns every built-in tool, configured against the given context.
 * Phase 2 commits append factories to this list one by one.
 */
export function buildTools(_ctx: ToolContext): AgentTool<any>[] {
	return [];
}
