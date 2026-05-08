import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Static, useStdout } from "ink";
import { useEffect, useState } from "react";
import { Message } from "./Message.js";

interface MessageListProps {
	messages: AgentMessage[];
	streaming?: AgentMessage;
}

/**
 * Static finalized history + a live streaming pane. Ink's <Static> renders
 * each item exactly once, so a 200-message session doesn't repaint the
 * scrollback on every token of the in-progress assistant reply.
 *
 * Threads the live terminal width down to Message so its body pre-wraps
 * at word boundaries — see ui/wrap.ts for why we want manual wrap.
 */
export function MessageList({ messages, streaming }: MessageListProps) {
	const width = useTerminalWidth();
	return (
		<Box flexDirection="column">
			<Static items={messages.map((message, index) => ({ message, key: indexKey(message, index) }))}>
				{({ message, key }) => (
					<Box key={key} marginBottom={1}>
						<Message message={message} width={width} />
					</Box>
				)}
			</Static>
			{streaming ? (
				<Box marginBottom={1}>
					<Message message={streaming} streaming width={width} />
				</Box>
			) : null}
		</Box>
	);
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

function indexKey(message: AgentMessage, index: number): string {
	const ts = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
	return `${index}:${message.role}:${ts}`;
}
