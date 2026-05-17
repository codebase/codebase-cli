import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	task_id: Type.String({
		description: 'Background-shell id from a prior `shell({background:true})` call (e.g. "bg-3").',
	}),
	match: Type.Optional(
		Type.String({
			description:
				'JavaScript regex (without surrounding slashes) applied per line. Omit to be notified on every line. Examples: "ERROR|FATAL", "^Listening on", "compiled successfully".',
		}),
	),
	flags: Type.Optional(
		Type.String({
			description:
				'Regex flags for `match`. Default "i" (case-insensitive). Use "" for case-sensitive matching, or any combination of i, m, s, u.',
		}),
	),
	max_matches: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			description:
				'Stop monitoring after this many matches and auto-unregister. Useful for one-shot triggers like "tell me when this server prints `Listening on`".',
		}),
	),
	note: Type.Optional(
		Type.String({
			description:
				'Free-form note included with each notification ("watching nginx error log"). Helps future-you remember why this monitor exists.',
		}),
	),
});

export type MonitorParams = Static<typeof Params>;

const DESCRIPTION = `Register a push-style monitor on a background shell. Each new line in the shell's
output is tested against an optional regex; matches steer a system-reminder
into your conversation so you see them as they happen — no polling
\`shell_output\` required.

Pattern: \`shell({background:true, command:"tail -f logs/app.log"})\` →
\`monitor({task_id:"bg-1", match:"ERROR|FATAL"})\`. From then on, any line in
the log matching the regex is delivered to you mid-conversation; you can
react immediately or just acknowledge.

Lifecycle: the monitor is auto-removed when the watched shell exits (no
more output → no monitor needed). Use \`monitor_stop({monitor_id})\` to
unregister early. Use \`max_matches\` for one-shot triggers ("notify me
the FIRST time you see 'Listening on'").

Use this instead of polling \`shell_output\` when you want to be notified
of an event as it happens.`;

export function createMonitor(ctx: ToolContext): AgentTool<typeof Params> {
	return {
		name: "monitor",
		label: "Monitor",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const shell = ctx.backgroundShells.get(params.task_id);
			if (!shell) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `No background shell with id "${params.task_id}". Run shell({background:true, command:...}) first to get one.`,
						},
					],
					isError: true,
				};
			}
			if (shell.status !== "running") {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text:
								`Background shell ${params.task_id} already ${shell.status}` +
								(shell.exitCode !== undefined ? ` with code ${shell.exitCode}` : "") +
								". Nothing to monitor.",
						},
					],
					isError: true,
				};
			}

			let regex: RegExp | undefined;
			if (params.match !== undefined && params.match.length > 0) {
				const flags = params.flags ?? "i";
				try {
					regex = new RegExp(params.match, flags);
				} catch (err) {
					return {
						details: undefined,
						content: [
							{
								type: "text",
								text: `Invalid regex /${params.match}/${flags}: ${(err as Error).message}`,
							},
						],
						isError: true,
					};
				}
			}

			const monitor = ctx.monitors.register({
				taskId: params.task_id,
				regex,
				maxMatches: params.max_matches,
				note: params.note,
			});

			const what = regex ? `lines matching /${regex.source}/${regex.flags}` : "every line";
			const cap = params.max_matches
				? ` (auto-stops after ${params.max_matches} match${params.max_matches === 1 ? "" : "es"})`
				: "";
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text:
							`Monitoring ${params.task_id} for ${what}${cap}.\n` +
							`Monitor id: ${monitor.id}. You'll be notified as matches arrive; ` +
							"call monitor_stop to unregister early.",
					},
				],
			};
		},
	};
}
