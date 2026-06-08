import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	monitor_id: Type.String({
		description: 'Monitor id from a prior `monitor(...)` call (e.g. "mon-3").',
	}),
});

export type MonitorStopParams = Static<typeof Params>;

const DESCRIPTION = `Unregister a previously-registered monitor. Use this when you've gotten
what you needed from a long-running monitor and want to silence further
notifications. The watched background shell keeps running — only the
notification subscription is removed. (Use shell_kill to stop the shell
itself.)`;

export function createMonitorStop(ctx: ToolContext): AgentTool<typeof Params> {
	return {
		name: "monitor_stop",
		label: "Stop monitor",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const removed = ctx.monitors.remove(params.monitor_id);
			if (!removed) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `No active monitor with id "${params.monitor_id}". It may have already auto-stopped (target shell exited or max_matches reached).`,
						},
					],
				};
			}
			return {
				details: undefined,
				content: [{ type: "text", text: `Unregistered monitor ${params.monitor_id}.` }],
			};
		},
	};
}
