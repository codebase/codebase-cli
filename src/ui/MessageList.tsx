import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Static, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { ToolExecution } from "../types.js";
import { Message } from "./Message.js";

interface MessageListProps {
	messages: AgentMessage[];
	streaming?: AgentMessage;
	/** Live tool-call status by id — used by Message to render spinner + tense. */
	tools?: ReadonlyMap<string, ToolExecution>;
}

/**
 * Static finalized history + a live streaming pane. Ink's <Static> renders
 * each item exactly once, so a 200-message session doesn't repaint the
 * scrollback on every token of the in-progress assistant reply.
 *
 * Threads the live terminal width down to Message so its body pre-wraps
 * at word boundaries — see ui/wrap.ts for why we want manual wrap.
 *
 * Note: the static-rendered finalized messages don't see live `tools`
 * updates after they're committed — that's fine because by the time a
 * message is finalized its tool calls have completed. The streaming
 * pane (which DOES update) is where the live spinner lives.
 */
export function MessageList({ messages, streaming, tools }: MessageListProps) {
	const width = useTerminalWidth();
	const rows = useTerminalRows();
	// Cap how many lines the streaming pane renders. The big jank class
	// users hit is: streaming message grows past the visible viewport,
	// every token update writes more lines than before, and the terminal
	// scrolls them down — yanking the user's manual scroll position to
	// the bottom on every keystroke from the model. By trimming the
	// streamed body to a bounded *tail* (the most recent N text lines),
	// the rendered region is constant-height after it fills, log-update
	// clears and rewrites the same number of rows every time, and the
	// terminal stops fighting the scrollbar. The full message goes into
	// <Static> once finalized so terminal scrollback still has the rest.
	//
	// Reserve a chunk for chrome (input bar, status, welcome banner).
	// 12 rows is conservative — leaves enough room that the user can
	// still see "the agent is doing something" without the tree ever
	// trying to exceed the viewport.
	const streamingTailRows = Math.max(8, rows - 12);
	const visibleStreaming = useMemo(
		() => (streaming ? clipToTail(streaming, streamingTailRows) : undefined),
		[streaming, streamingTailRows],
	);
	return (
		<Box flexDirection="column">
			<Static items={messages.map((message, index) => ({ message, key: indexKey(message, index) }))}>
				{({ message, key }) => (
					<Box key={key} marginBottom={1}>
						<Message message={message} width={width} tools={tools} />
					</Box>
				)}
			</Static>
			{visibleStreaming ? (
				<Box marginBottom={1}>
					<Message message={visibleStreaming} streaming width={width} tools={tools} />
				</Box>
			) : null}
		</Box>
	);
}

/**
 * Trim an in-flight assistant message down to ~`maxLines` of trailing
 * content for live rendering. Content blocks are processed back-to-front
 * until we've accumulated enough lines; earlier blocks are dropped or
 * truncated. The original message object is unchanged — this returns a
 * shallow copy with a new `content` array.
 *
 * Tool calls/results stay intact (each counts as ~1 row, replacing a
 * dropped tool call would change the message's meaning to the user).
 * Text blocks at the head of the kept region get a leading-line trim
 * with a one-line "(earlier output trimmed)" marker so it's obvious
 * we're showing a tail.
 */
function clipToTail<T extends AgentMessage>(message: T, maxLines: number): T {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const blocks = message.content;
	const kept: typeof blocks = [];
	let remaining = maxLines;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (remaining <= 0) break;
		if (block.type === "text" && typeof block.text === "string") {
			const lines = block.text.split("\n");
			if (lines.length <= remaining) {
				kept.unshift(block);
				remaining -= lines.length;
			} else {
				const tail = lines.slice(lines.length - remaining).join("\n");
				kept.unshift({
					...block,
					text: `(earlier output trimmed — full message in scrollback once finished)\n${tail}`,
				});
				remaining = 0;
			}
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			const lines = block.thinking.split("\n");
			if (lines.length <= remaining) {
				kept.unshift(block);
				remaining -= lines.length;
			} else {
				const tail = lines.slice(lines.length - remaining).join("\n");
				kept.unshift({ ...block, thinking: tail });
				remaining = 0;
			}
		} else {
			// Tool calls / results: keep verbatim, count as 1 row each.
			kept.unshift(block);
			remaining -= 1;
		}
	}
	if (kept.length === blocks.length) return message;
	return { ...message, content: kept };
}

function useTerminalWidth(fallback = 80): number {
	const { stdout } = useStdout();
	const [width, setWidth] = useState(stdout?.columns ?? fallback);
	useEffect(() => {
		if (!stdout) return;
		const onResize = () => setWidth(stdout.columns ?? fallback);
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout, fallback]);
	return width;
}

function useTerminalRows(fallback = 24): number {
	const { stdout } = useStdout();
	const [rows, setRows] = useState(stdout?.rows ?? fallback);
	useEffect(() => {
		if (!stdout) return;
		const onResize = () => setRows(stdout.rows ?? fallback);
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout, fallback]);
	return rows;
}

function indexKey(message: AgentMessage, index: number): string {
	const ts = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
	return `${index}:${message.role}:${ts}`;
}
