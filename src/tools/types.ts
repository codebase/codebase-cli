import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { FileStateCache } from "./file-state-cache.js";
import type { TaskStore } from "./task-store.js";

/**
 * Per-agent-instance services available to every tool. Threaded through
 * tool factories so individual tools stay testable in isolation.
 */
export interface ToolContext {
	cwd: string;
	fileStateCache: FileStateCache;
	tasks: TaskStore;
	/**
	 * Spawn a fresh Agent for sub-tasks (used by dispatch_agent). The
	 * factory inherits the parent's model and apiKey but takes its own
	 * system prompt and tool set — that's how the read-only subagent
	 * isolation is enforced.
	 */
	spawnSubagent: (config: SpawnSubagentConfig) => Agent;
}

export interface SpawnSubagentConfig {
	systemPrompt: string;
	tools: AgentTool<TSchema>[];
}

/** A tool definition + its dependency context. Builders return one of these. */
export type ToolFactory = (ctx: ToolContext) => AgentTool<TSchema>;
