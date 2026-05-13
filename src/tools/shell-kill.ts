import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	task_id: Type.String({
		description: 'Background-shell id to terminate — e.g. "bg-3".',
	}),
});

export type ShellKillParams = Static<typeof Params>;

const DESCRIPTION = `Terminate a background shell.

Sends SIGTERM and waits up to 2s for the process to exit cleanly; sends SIGKILL
after that if the process is still alive. No-op (and not an error) if the task
has already exited on its own.`;

export function createShellKill(ctx: ToolContext): AgentTool<typeof Params> {
	return {
		name: "shell_kill",
		label: "Background kill",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const before = ctx.backgroundShells.get(params.task_id);
			if (!before) {
				return {
					details: undefined,
					content: [{ type: "text", text: `No background shell with id "${params.task_id}".` }],
					isError: true,
				};
			}
			if (before.status !== "running") {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Background shell ${params.task_id} already ${before.status}${
								before.exitCode !== undefined ? ` with code ${before.exitCode}` : ""
							}.`,
						},
					],
				};
			}
			await ctx.backgroundShells.kill(params.task_id);
			const after = ctx.backgroundShells.get(params.task_id);
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Terminated background shell ${params.task_id}.${
							after?.signal ? ` (signal: ${after.signal})` : ""
						}`,
					},
				],
			};
		},
	};
}
