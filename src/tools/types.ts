import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { FileStateCache } from "./file-state-cache.js";

/**
 * Per-agent-instance services available to every tool. Threaded through
 * tool factories so individual tools stay testable in isolation.
 */
export interface ToolContext {
	cwd: string;
	fileStateCache: FileStateCache;
}

/** A tool definition + its dependency context. Builders return one of these. */
export type ToolFactory = (ctx: ToolContext) => AgentTool<TSchema>;
