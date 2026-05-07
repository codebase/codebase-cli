import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Phase 2 fills this in. The agent loop accepts an empty array,
 * so Phase 1 runs as a chat-only agent.
 */
export function buildTools(): AgentTool<any>[] {
	return [];
}
