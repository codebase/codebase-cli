import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ToolExecution } from "../types.js";
import { DiffSummary, diffSummary } from "./diff-summary.js";
import { displayPath } from "./paths.js";
import {
	nounForReadTool,
	pastVerbForReadTool,
	presentVerbForReadTool,
	toolActionLabel,
	toolActionPast,
	truncate,
} from "./tool-labels.js";
import { WrappedLines } from "./wrapped-lines.js";

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

export function useSpinner(active: boolean, intervalMs = 90): string {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);
	return SPINNER_FRAMES[frame];
}

/**
 * Tool calls that are pure reads — runs of these collapse into a single
 * "Read N files" / "Searched 3 patterns" line. Keep the set tight:
 * anything that mutates state, runs shell, or has a meaningful argument
 * shape (grep query, fetch URL) reads weird when collapsed and stays
 * per-row.
 */
export const COLLAPSIBLE_READ_TOOLS: ReadonlySet<string> = new Set(["read_file"]);

export type AssistantContent = (AgentMessage & { role: "assistant" })["content"];
export type AssistantToolCall = Extract<AssistantContent[number], { type: "toolCall" }>;

/**
 * One tool-call row that morphs through three states:
 *   running  → spinner + present tense  ("⣾ Reading src/index.ts")
 *   done     → ✓ + past tense           ("✓ Read src/index.ts")
 *   error    → ✗ + past tense + red     ("✗ Read src/index.ts")
 *
 * State source: the per-session `tools` Map on ChatState. If no entry
 * exists for this id (e.g. an old session being replayed without
 * inflight tracking), we render the past-tense "done" form — safe
 * fallback that never strands the UI on a fake spinner.
 */
export function ToolCallLine({
	id,
	name,
	args,
	width,
	keyPrefix,
	tools,
}: {
	id: string;
	name: string;
	args: unknown;
	width: number;
	keyPrefix: string;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	const exec = tools?.get(id);
	const status = exec?.status ?? "done";
	const isRunning = status === "running";
	const spinner = useSpinner(isRunning);

	if (isRunning) {
		return (
			<WrappedLines
				text={`${spinner} ${toolActionLabel(name, args)}…`}
				width={width}
				keyPrefix={keyPrefix}
				color="magenta"
			/>
		);
	}

	const isError = status === "error";
	const glyph = isError ? "✗" : "✓";
	const past = toolActionPast(name, args);
	const diff = !isError ? diffSummary(name, args) : null;
	return (
		<>
			<WrappedLines
				text={`${glyph} ${past}`}
				width={width}
				keyPrefix={keyPrefix}
				color={isError ? "red" : "magenta"}
			/>
			{diff ? <DiffSummary diff={diff} width={width} keyPrefix={`${keyPrefix}-diff`} /> : null}
		</>
	);
}

/**
 * Collapsed row for a run of pure-read tool calls. Renders as
 * "✓ Read N files" with the per-file paths in a dim indented list
 * beneath. If any call errored, the glyph flips to ✗ and the line
 * goes red — we still show the paths so the user can see what
 * failed.
 */
export function CollapsedReadGroup({
	calls,
	width,
	keyPrefix,
	tools,
}: {
	calls: readonly AssistantToolCall[];
	width: number;
	keyPrefix: string;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	const statuses = calls.map((c) => tools?.get(c.id)?.status);
	const anyRunning = statuses.some((s) => s === "running");
	const anyError = statuses.some((s) => s === "error");
	const doneCount = statuses.filter((s) => s !== "running").length;
	const spinner = useSpinner(anyRunning);
	const glyph = anyRunning ? spinner : anyError ? "✗" : "✓";
	const color = anyError ? "red" : "magenta";
	const verb = anyRunning ? presentVerbForReadTool(calls[0].name) : pastVerbForReadTool(calls[0].name);
	const noun = nounForReadTool(calls[0].name, calls.length);
	const header = anyRunning
		? `${glyph} ${verb} ${doneCount} of ${calls.length} ${noun}…`
		: `${glyph} ${verb} ${calls.length} ${noun}`;
	return (
		<>
			<WrappedLines text={header} width={width} keyPrefix={keyPrefix} color={color} />
			<Box flexDirection="column" marginLeft={2}>
				{calls.map((c) => {
					const a = (c.arguments ?? {}) as Record<string, unknown>;
					const rawPath = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
					const path = displayPath(rawPath);
					const status = tools?.get(c.id)?.status;
					const failed = status === "error";
					const running = status === "running";
					const marker = failed ? "  ✗ " : running ? "  → " : "  · ";
					return (
						<Text
							key={`${keyPrefix}-f-${c.id}`}
							color={failed ? "red" : running ? "magenta" : undefined}
							dimColor={!failed && !running}
						>
							{marker}
							{truncate(path, Math.max(20, width - 6))}
						</Text>
					);
				})}
			</Box>
		</>
	);
}
