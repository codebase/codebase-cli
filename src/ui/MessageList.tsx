import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Static } from "ink";
import { Message } from "./Message.js";

interface MessageListProps {
	messages: AgentMessage[];
	streaming?: AgentMessage;
}

/**
 * Static finalized history + a live streaming pane. Ink's <Static> renders
 * each item exactly once, so a 200-message session doesn't repaint the
 * scrollback on every token of the in-progress assistant reply.
 */
export function MessageList({ messages, streaming }: MessageListProps) {
	return (
		<Box flexDirection="column">
			<Static items={messages.map((message, index) => ({ message, key: indexKey(message, index) }))}>
				{({ message, key }) => (
					<Box key={key} marginBottom={1}>
						<Message message={message} />
					</Box>
				)}
			</Static>
			{streaming ? (
				<Box marginBottom={1}>
					<Message message={streaming} streaming />
				</Box>
			) : null}
		</Box>
	);
}

function indexKey(message: AgentMessage, index: number): string {
	const ts = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
	return `${index}:${message.role}:${ts}`;
}
