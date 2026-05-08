import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ToolExecution } from "../types.js";

interface ToolPanelProps {
	tools: ReadonlyMap<string, ToolExecution>;
	/** Lines of partial output to preview per tool. Default 3. */
	previewLines?: number;
}

/**
 * Sticky panel showing in-flight tool calls. Pulls from ChatState's
 * tools map (pi-agent-core's tool_execution_start/update/end events)
 * and only renders rows whose status is "running" — completed tools
 * already appear as toolResult messages in the main chat, so showing
 * them again here would be noise.
 *
 * Re-renders once per second to tick the elapsed counter without
 * disturbing the parent reducer. The interval is cheap and only runs
 * while at least one tool is in flight.
 */
export function ToolPanel({ tools, previewLines = 3 }: ToolPanelProps) {
	const running: ToolExecution[] = [];
	for (const tool of tools.values()) {
		if (tool.status === "running") running.push(tool);
	}
	const [, force] = useState(0);

	// Tick once a second so elapsed counters update. The interval only runs
	// while a tool is actually running — when `tools` changes such that the
	// running set is empty, the cleanup tears down the timer.
	useEffect(() => {
		let hasRunning = false;
		for (const tool of tools.values()) {
			if (tool.status === "running") {
				hasRunning = true;
				break;
			}
		}
		if (!hasRunning) return;
		const id = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [tools]);

	if (running.length === 0) return null;

	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			{running.map((tool) => (
				<RunningTool key={tool.id} tool={tool} previewLines={previewLines} />
			))}
		</Box>
	);
}

interface RunningToolProps {
	tool: ToolExecution;
	previewLines: number;
}

function RunningTool({ tool, previewLines }: RunningToolProps) {
	const elapsed = Math.max(0, Math.round((Date.now() - tool.startedAt) / 1000));
	const argsHint = summarizeArgs(tool.args);
	return (
		<Box flexDirection="column">
			<Box>
				<Text color="magenta">→ </Text>
				<Text color="magenta" bold>
					{tool.name}
				</Text>
				{argsHint ? <Text dimColor>{` (${argsHint})`}</Text> : null}
				<Text dimColor>{` · ${elapsed}s`}</Text>
			</Box>
			{tool.result ? <PartialOutput text={tool.result} maxLines={previewLines} /> : null}
		</Box>
	);
}

function PartialOutput({ text, maxLines }: { text: string; maxLines: number }) {
	const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
	const tail = lines.slice(-maxLines);
	if (tail.length === 0) return null;
	return (
		<Box flexDirection="column" marginLeft={2}>
			{tail.map((line, i) => (
				// PartialOutput is purely presentational — index keys are safe
				// because the tail slides forward as new lines arrive and there's
				// no per-line state to mix up.
				// biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf
				<Text key={i} dimColor>
					{truncate(line, 100)}
				</Text>
			))}
		</Box>
	);
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 2);
	return entries
		.map(([k, v]) => {
			const s = typeof v === "string" ? `"${truncate(v, 24)}"` : safeJson(v);
			return `${k}=${s}`;
		})
		.join(", ");
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v).slice(0, 24);
	} catch {
		return String(v).slice(0, 24);
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
