import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "ink";

interface MessageProps {
	message: AgentMessage;
	streaming?: boolean;
}

const ROLE_STYLE = {
	user: { accent: "yellow", label: "you" },
	assistant: { accent: "cyan", label: "codebase" },
	toolResult: { accent: "magenta", label: "tool" },
} as const;

export function Message({ message, streaming }: MessageProps) {
	const role = message.role;
	const style = ROLE_STYLE[role as keyof typeof ROLE_STYLE];
	if (!style) return null;

	return (
		<Box flexDirection="row" marginY={0}>
			<Box marginRight={1}>
				<Text color={style.accent}>│</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				<Text color={style.accent} bold>
					{style.label}
					{streaming ? " …" : ""}
				</Text>
				<MessageBody message={message} />
			</Box>
		</Box>
	);
}

function MessageBody({ message }: { message: AgentMessage }) {
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : renderUserContent(message.content);
		return <Text>{text}</Text>;
	}

	if (message.role === "assistant") {
		return (
			<>
				{message.content.map((block, idx) => {
					const key = blockKey(block, idx);
					if (block.type === "text") {
						return <Text key={key}>{block.text}</Text>;
					}
					if (block.type === "thinking") {
						return (
							<Text key={key} dimColor italic>
								(thinking) {block.thinking}
							</Text>
						);
					}
					if (block.type === "toolCall") {
						return (
							<Text key={key} color="magenta">
								→ {block.name}({summarizeArgs(block.arguments)})
							</Text>
						);
					}
					return null;
				})}
				{message.errorMessage ? <Text color="red">! {message.errorMessage}</Text> : null}
			</>
		);
	}

	if (message.role === "toolResult") {
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`))
			.join("");
		return <Text color={message.isError ? "red" : undefined}>{text}</Text>;
	}

	return null;
}

function renderUserContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type: string; text?: string; mimeType?: string }) =>
			block.type === "text" ? (block.text ?? "") : `[image:${block.mimeType ?? "?"}]`,
		)
		.join("");
}

/**
 * Stable key per assistant content block. Tool calls have an id; text and
 * thinking blocks don't reorder within a message so position-in-type is fine.
 */
function blockKey(block: { type: string; id?: string }, idx: number): string {
	if (block.type === "toolCall" && block.id) return `tc-${block.id}`;
	return `${block.type}-${idx}`;
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
	return entries
		.map(([k, v]) => {
			const s = typeof v === "string" ? `"${v.slice(0, 30)}"` : String(v);
			return `${k}=${s}`;
		})
		.join(", ");
}
