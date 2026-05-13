import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	task_id: Type.String({
		description: 'Background-shell id returned by `shell({ background: true })` — e.g. "bg-3".',
	}),
});

export type ShellOutputParams = Static<typeof Params>;

const DESCRIPTION = `Read accumulated stdout+stderr from a background shell.

Returns the buffered output (capped at 64KB, head-truncated when full) plus the current
status (running / exited / killed). Polls the live buffer — if the process is still
running, call again later to get more output. You'll also be auto-notified when
the process exits, so polling without reason isn't necessary.

If the buffer was head-truncated due to volume, the very-earliest output is gone
but the most recent 64KB is intact — that's almost always what you actually want
to see.`;

export function createShellOutput(ctx: ToolContext): AgentTool<typeof Params> {
	return {
		name: "shell_output",
		label: "Background output",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const record = ctx.backgroundShells.get(params.task_id);
			if (!record) {
				return {
					details: undefined,
					content: [{ type: "text", text: `No background shell with id "${params.task_id}".` }],
					isError: true,
				};
			}
			const elapsedMs = (record.endedAt ?? Date.now()) - record.startedAt;
			const status =
				record.status === "running"
					? "running"
					: record.status === "killed"
						? `killed${record.signal ? ` (${record.signal})` : ""}`
						: `exited with code ${record.exitCode ?? "?"}`;
			const truncatedNote =
				record.bytesEmitted > record.output.length
					? `\n[earlier output truncated — ${record.bytesEmitted - record.output.length} bytes lost from the head of the buffer]\n`
					: "";
			const header =
				`task ${record.id} · ${status} · ${Math.round(elapsedMs / 1000)}s · ${record.bytesEmitted} bytes total\n` +
				`$ ${record.command}\n`;
			const body = record.output.length === 0 ? "(no output yet)" : record.output;
			return {
				details: undefined,
				content: [{ type: "text", text: `${header}${truncatedNote}${body}` }],
			};
		},
	};
}
