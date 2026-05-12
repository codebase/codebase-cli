import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ToolExecution } from "../types.js";
import { Markdown } from "./Markdown.js";
import { type AssistantContent, COLLAPSIBLE_READ_TOOLS, CollapsedReadGroup, ToolCallLine } from "./tool-call-line.js";
import { TruncatedOutput } from "./truncated-output.js";
import { WrappedLines } from "./wrapped-lines.js";

interface MessageProps {
	message: AgentMessage;
	streaming?: boolean;
	/** Terminal columns available to the message body, post-padding. Defaults to 80. */
	width?: number;
	/**
	 * Per-tool-call status from the agent loop. Used to render tool-call
	 * blocks with a live spinner + present tense ("Reading X") while
	 * running, and a ✓/✗ + past tense ("Read X") once complete — the
	 * Claude Code pattern.
	 */
	tools?: ReadonlyMap<string, ToolExecution>;
}

const ROLE_STYLE = {
	user: { accent: "yellow", label: "you" },
	assistant: { accent: "cyan", label: "codebase" },
	toolResult: { accent: "magenta", label: "tool" },
} as const;

/**
 * Per-tool name overrides for the toolResult header label. Default falls
 * back to the raw tool name (read_file, grep, shell, …) which is more
 * useful than a generic "tool". A few tools get friendlier presentation
 * labels because their raw name reads oddly in the gutter.
 */
const TOOL_RESULT_LABEL: Record<string, string> = {
	shell: "bash",
	dispatch_agent: "subagent",
};

export function Message({ message, streaming, width = 80, tools }: MessageProps) {
	const role = message.role;
	const style = ROLE_STYLE[role as keyof typeof ROLE_STYLE];
	if (!style) return null;

	// The body sits inside `Box flexDirection=row` with a 1-col accent + 1-col
	// gap, plus the parent App's paddingX of 1 each side. Reserve 4 cols so
	// the wrapped text never tries to occupy the accent gutter.
	const bodyWidth = Math.max(20, width - 4);
	// Tool results carry the originating tool name on the message itself
	// (set by pi-agent-core). Surface that instead of the generic "tool"
	// label so users can see at a glance which tool produced this output.
	const headerLabel =
		role === "toolResult" && "toolName" in message && typeof message.toolName === "string"
			? (TOOL_RESULT_LABEL[message.toolName] ?? message.toolName)
			: style.label;

	return (
		<Box flexDirection="row" marginY={0}>
			<Box marginRight={1}>
				<Text color={style.accent}>│</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				<Text color={style.accent} bold>
					{headerLabel}
					{streaming ? " …" : ""}
				</Text>
				<MessageBody message={message} width={bodyWidth} tools={tools} />
			</Box>
		</Box>
	);
}

function MessageBody({
	message,
	width,
	tools,
}: {
	message: AgentMessage;
	width: number;
	tools?: ReadonlyMap<string, ToolExecution>;
}) {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return <WrappedLines text={message.content} width={width} keyPrefix="user" />;
		}
		return <UserBlocks blocks={message.content} width={width} />;
	}

	if (message.role === "assistant") {
		const rendered = renderAssistantBlocks(message.content, width, tools);
		return (
			<>
				{rendered}
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
		const toolName = "toolName" in message && typeof message.toolName === "string" ? message.toolName : undefined;
		return (
			<TruncatedOutput
				text={text}
				width={width}
				keyPrefix="tool"
				color={message.isError ? "red" : undefined}
				toolName={toolName}
			/>
		);
	}

	return null;
}

/**
 * Walk an assistant message's content blocks, collapsing runs of
 * consecutive `read_file` (and other safe read-only) tool calls into a
 * single summary row. A run only collapses when every call in it is
 * completed (done or errored) — if any is still running we render the
 * group expanded so the spinner stays visible on the active row.
 */
function renderAssistantBlocks(
	content: AssistantContent,
	width: number,
	tools?: ReadonlyMap<string, ToolExecution>,
): ReactNode[] {
	const out: ReactNode[] = [];
	let i = 0;
	while (i < content.length) {
		const block = content[i];
		const key = blockKey(block, i);
		if (block.type === "text") {
			out.push(<Markdown key={key} text={block.text} width={width} keyPrefix={key} />);
			i++;
			continue;
		}
		if (block.type === "thinking") {
			out.push(
				<WrappedLines
					key={key}
					text={`(thinking) ${block.thinking}`}
					width={width}
					keyPrefix={key}
					dimColor
					italic
				/>,
			);
			i++;
			continue;
		}
		if (block.type === "toolCall") {
			if (COLLAPSIBLE_READ_TOOLS.has(block.name)) {
				let runEnd = i + 1;
				while (runEnd < content.length) {
					const next = content[runEnd];
					if (next.type !== "toolCall" || next.name !== block.name) break;
					runEnd++;
				}
				const run = [];
				for (let j = i; j < runEnd; j++) {
					const b = content[j];
					if (b.type === "toolCall") run.push(b);
				}
				if (run.length >= 2) {
					out.push(
						<CollapsedReadGroup
							key={`run-${run[0].id}`}
							calls={run}
							width={width}
							keyPrefix={`run-${run[0].id}`}
							tools={tools}
						/>,
					);
					i = runEnd;
					continue;
				}
			}
			out.push(
				<ToolCallLine
					key={key}
					id={block.id}
					name={block.name}
					args={block.arguments}
					width={width}
					keyPrefix={key}
					tools={tools}
				/>,
			);
			i++;
			continue;
		}
		i++;
	}
	return out;
}

/**
 * Render an array-content user message — typically text + one or more
 * image attachments. Text blocks pass through `WrappedLines`; image
 * blocks render as a dim "image (PNG, 142 KB)" line so the user can
 * see at a glance that an image was sent.
 */
function UserBlocks({ blocks, width }: { blocks: unknown; width: number }) {
	if (!Array.isArray(blocks)) return null;
	const rows: ReactNode[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i] as { type: string; text?: string; mimeType?: string; data?: string };
		if (b.type === "text" && b.text) {
			rows.push(<WrappedLines key={`u-t-${i}`} text={b.text} width={width} keyPrefix={`u-t-${i}`} />);
			continue;
		}
		if (b.type === "image") {
			const subtype = (b.mimeType ?? "image/?").split("/")[1]?.toUpperCase() ?? "?";
			const size = b.data ? formatBytes(Math.floor((b.data.length * 3) / 4)) : "";
			rows.push(
				<Text key={`u-i-${i}`} dimColor>
					📷 image ({subtype}
					{size ? `, ${size}` : ""})
				</Text>,
			);
		}
	}
	return <>{rows}</>;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Stable key per assistant content block. Tool calls have an id; text and
 * thinking blocks don't reorder within a message so position-in-type is fine.
 */
function blockKey(block: { type: string; id?: string }, idx: number): string {
	if (block.type === "toolCall" && block.id) return `tc-${block.id}`;
	return `${block.type}-${idx}`;
}
