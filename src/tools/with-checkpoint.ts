import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CheckpointStore } from "../checkpoint/store.js";
import { resolveInsideCwd } from "./file-ops.js";
import type { ToolContext } from "./types.js";

/** Tools whose `path` argument names a file they're about to mutate. */
const MUTATING_FILE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);

/**
 * Snapshot the target file's pre-image before a mutating tool runs, so
 * /rewind can restore it. The entry is discarded when the tool refuses
 * or errors — a write that never landed shouldn't appear as a rewind
 * point. Non-mutating tools pass through untouched.
 */
export function withCheckpoint(tool: AgentTool<any>, ctx: ToolContext): AgentTool<any> {
	if (!MUTATING_FILE_TOOLS.has(tool.name) || !ctx.checkpoints) return tool;
	const checkpoints = ctx.checkpoints;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			let seq: number | undefined;
			const requested = (params as { path?: unknown })?.path;
			if (typeof requested === "string" && requested.length > 0) {
				try {
					seq = checkpoints.record(tool.name, resolveInsideCwd(ctx.cwd, requested));
				} catch {
					// Path the tool itself will reject (outside project root) —
					// nothing to checkpoint.
				}
			}
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);
				if ((result as { isError?: boolean })?.isError) checkpoints.discard(seq);
				return result;
			} catch (err) {
				checkpoints.discard(seq);
				throw err;
			}
		},
	};
}
