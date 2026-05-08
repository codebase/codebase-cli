import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "ink";
import { wrapText } from "./wrap.js";

interface MessageProps {
	message: AgentMessage;
	streaming?: boolean;
	/** Terminal columns available to the message body, post-padding. Defaults to 80. */
	width?: number;
}

const ROLE_STYLE = {
	user: { accent: "yellow", label: "you" },
	assistant: { accent: "cyan", label: "codebase" },
	toolResult: { accent: "magenta", label: "tool" },
} as const;

export function Message({ message, streaming, width = 80 }: MessageProps) {
	const role = message.role;
	const style = ROLE_STYLE[role as keyof typeof ROLE_STYLE];
	if (!style) return null;

	// The body sits inside `Box flexDirection=row` with a 1-col accent + 1-col
	// gap, plus the parent App's paddingX of 1 each side. Reserve 4 cols so
	// the wrapped text never tries to occupy the accent gutter.
	const bodyWidth = Math.max(20, width - 4);

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
				<MessageBody message={message} width={bodyWidth} />
			</Box>
		</Box>
	);
}

function MessageBody({ message, width }: { message: AgentMessage; width: number }) {
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : renderUserContent(message.content);
		return <WrappedLines text={text} width={width} keyPrefix="user" />;
	}

	if (message.role === "assistant") {
		return (
			<>
				{message.content.map((block, idx) => {
					const key = blockKey(block, idx);
					if (block.type === "text") {
						return <WrappedLines key={key} text={block.text} width={width} keyPrefix={key} />;
					}
					if (block.type === "thinking") {
						return (
							<WrappedLines
								key={key}
								text={`(thinking) ${block.thinking}`}
								width={width}
								keyPrefix={key}
								dimColor
								italic
							/>
						);
					}
					if (block.type === "toolCall") {
						return (
							<WrappedLines
								key={key}
								text={`→ ${block.name}(${summarizeArgs(block.arguments)})`}
								width={width}
								keyPrefix={key}
								color="magenta"
							/>
						);
					}
					return null;
				})}
				{message.errorMessage ? (
					<WrappedLines text={`! ${message.errorMessage}`} width={width} keyPrefix="err" color="red" />
				) : null}
			</>
		);
	}

	if (message.role === "toolResult") {
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`))
			.join("");
		return <WrappedLines text={text} width={width} keyPrefix="tool" color={message.isError ? "red" : undefined} />;
	}

	return null;
}

interface WrappedLinesProps {
	text: string;
	width: number;
	keyPrefix: string;
	color?: string;
	dimColor?: boolean;
	italic?: boolean;
}

/**
 * Render text as N <Text> elements, one per pre-wrapped line. Stacks
 * vertically inside the parent column-flex Box. Pre-wrap means the
 * wraps happen at word boundaries, so when the user select-and-copies
 * they get clean line endings — no mid-word breaks at column edges.
 */
function WrappedLines({ text, width, keyPrefix, color, dimColor, italic }: WrappedLinesProps) {
	const lines = wrapText(text, width);
	return (
		<>
			{lines.map((line, i) => (
				// Wrapped lines have no per-line state — <Text> is pure-presentational —
				// so reusing instances on re-wrap is harmless; index-as-key is fine here.
				// biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf, reuse is safe
				<Text key={`${keyPrefix}:${i}`} color={color} dimColor={dimColor} italic={italic}>
					{line.length === 0 ? " " : line}
				</Text>
			))}
		</>
	);
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
