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
								text={`▸ ${toolActionLabel(block.name, block.arguments)}`}
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

/**
 * Render a tool call as a human-friendly action label, the way Claude
 * Code formats them: present-tense verb + the salient argument
 * (file path, command, URL, search query, etc.) instead of the raw
 * `toolName(k1=v1, k2=v2)` shape. Falls back to the verbose form for
 * tools we don't have a special case for.
 */
function toolActionLabel(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
	const path = str("path") || str("file_path");

	switch (name) {
		case "read_file":
			return `Reading ${path}`;
		case "write_file":
			return `Writing ${path}`;
		case "edit_file":
			return `Editing ${path}`;
		case "multi_edit":
			return `Editing ${path}`;
		case "notebook_edit":
			return `Editing notebook ${path}`;
		case "list_files":
			return `Listing ${path || "."}`;
		case "glob":
			return `Searching ${str("pattern")}`;
		case "grep":
			return `Searching for "${str("pattern")}"`;
		case "shell":
			return `Running: ${truncate(str("command") || str("cmd"), 60)}`;
		case "web_fetch":
			return `Fetching ${str("url")}`;
		case "web_search":
			return `Searching: ${truncate(str("query"), 60)}`;
		case "git_status":
			return "git status";
		case "git_diff":
			return `git diff${str("target") ? ` ${str("target")}` : ""}`;
		case "git_log":
			return "git log";
		case "git_commit":
			return `git commit: ${truncate(str("message"), 50)}`;
		case "git_branch":
			return str("name") ? `git branch ${str("name")}` : "git branches";
		case "enter_worktree":
			return `Entering worktree ${str("branch") || str("name")}`;
		case "exit_worktree":
			return "Leaving worktree";
		case "enter_plan_mode":
			return "Entering plan mode";
		case "exit_plan_mode":
			return "Exiting plan mode";
		case "dispatch_agent":
			return `Dispatching subagent: ${truncate(str("task"), 60)}`;
		case "ask_user":
			return `Asking: ${truncate(str("question"), 60)}`;
		case "create_task":
			return `Task: ${truncate(str("subject"), 60)}`;
		case "update_task":
			return `Updating task ${str("taskId")}`;
		case "list_tasks":
			return "Listing tasks";
		case "get_task":
			return `Reading task ${str("taskId")}`;
		case "save_memory":
			return `Saving memory: ${str("name") || str("type")}`;
		case "read_memory":
			return str("filename") ? `Reading memory ${str("filename")}` : "Reading MEMORY.md";
		case "config":
			return str("path") ? `config(${str("path")})` : "Reading config";
		default:
			return `${name}(${summarizeArgs(args)})`;
	}
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
