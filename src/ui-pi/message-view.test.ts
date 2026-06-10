import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ToolExecution } from "../types.js";
import { buildMessageBlocks, CollapsedReadGroup, PlainText, ToolCallLine } from "./message-view.js";

const NO_TOOLS = new Map<string, ToolExecution>();

function userText(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function userBlocks(content: AgentMessage["content"]): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function assistantBlocks(content: AgentMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "x",
		usage: undefined,
		stopReason: "stop",
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(opts: { toolName: string; text: string; isError?: boolean }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc",
		toolName: opts.toolName,
		content: [{ type: "text", text: opts.text }],
		isError: opts.isError ?? false,
		timestamp: 0,
	} as AgentMessage;
}

describe("buildMessageBlocks", () => {
	it("renders user string content as a single PlainText", () => {
		const out = buildMessageBlocks(userText("hello world"), NO_TOOLS, "user");
		expect(out).toHaveLength(1);
		expect(out[0]).toBeInstanceOf(PlainText);
	});

	it("drops empty user string content", () => {
		const out = buildMessageBlocks(userText(""), NO_TOOLS, "user");
		expect(out).toEqual([]);
	});

	it("renders an image attachment as a 📷 card", () => {
		const blocks = userBlocks([
			{ type: "text", text: "look" },
			{ type: "image", data: "QUFBQQ==", mimeType: "image/png" },
		]);
		const out = buildMessageBlocks(blocks, NO_TOOLS, "user");
		expect(out).toHaveLength(2);
		// Image card lands as a PlainText whose rendered line includes the camera glyph.
		const line = (out[1] as PlainText).render(80)[0];
		expect(line).toContain("📷 image");
		expect(line).toContain("PNG");
	});

	it("skips unknown block types instead of crashing", () => {
		const blocks = userBlocks([{ type: "text", text: "hi" }, { type: "future-format-we-dont-know" } as any]);
		const out = buildMessageBlocks(blocks, NO_TOOLS, "user");
		expect(out).toHaveLength(1);
	});

	it("renders a single toolCall as one ToolCallLine", () => {
		const blocks = assistantBlocks([
			{ type: "toolCall", id: "a", name: "read_file", arguments: { path: "src/foo.ts" } },
		]);
		const out = buildMessageBlocks(blocks, NO_TOOLS, "assistant");
		expect(out).toHaveLength(1);
		expect(out[0]).toBeInstanceOf(ToolCallLine);
	});

	it("collapses 2+ consecutive read_file calls into a CollapsedReadGroup", () => {
		const blocks = assistantBlocks([
			{ type: "text", text: "reading" },
			{ type: "toolCall", id: "a", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "b", name: "read_file", arguments: { path: "b.ts" } },
			{ type: "toolCall", id: "c", name: "read_file", arguments: { path: "c.ts" } },
		]);
		const out = buildMessageBlocks(blocks, NO_TOOLS, "assistant");
		// 1 markdown text + 1 collapsed group (not 3 separate tool lines).
		expect(out).toHaveLength(2);
		expect(out[1]).toBeInstanceOf(CollapsedReadGroup);
	});

	it("does NOT collapse a single read_file (run-length < 2)", () => {
		const blocks = assistantBlocks([
			{ type: "toolCall", id: "a", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "b", name: "shell", arguments: { command: "ls" } },
		]);
		const out = buildMessageBlocks(blocks, NO_TOOLS, "assistant");
		expect(out).toHaveLength(2);
		expect(out[0]).toBeInstanceOf(ToolCallLine);
		expect(out[1]).toBeInstanceOf(ToolCallLine);
	});

	it("toolResult emits 3 blocks when output exceeds the per-tool cap", () => {
		const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const out = buildMessageBlocks(toolResult({ toolName: "shell", text }), NO_TOOLS, "toolResult");
		// head, "… N hidden …" marker, tail.
		expect(out).toHaveLength(3);
		const marker = (out[1] as PlainText).render(80)[0];
		expect(marker).toMatch(/lines hidden/);
	});

	it("toolResult emits the full output below the cap", () => {
		const text = "one\ntwo\nthree";
		const out = buildMessageBlocks(toolResult({ toolName: "shell", text }), NO_TOOLS, "toolResult");
		expect(out).toHaveLength(1);
	});

	it("toolResult NEVER truncates errors, even when long", () => {
		const text = Array.from({ length: 200 }, (_, i) => `boom ${i}`).join("\n");
		const out = buildMessageBlocks(toolResult({ toolName: "shell", text, isError: true }), NO_TOOLS, "toolResult");
		expect(out).toHaveLength(1);
	});
});

describe("CollapsedReadGroup", () => {
	const tools = new Map<string, ToolExecution>([
		["a", { id: "a", name: "read_file", args: {}, status: "done", startedAt: 0 }],
		["b", { id: "b", name: "read_file", args: {}, status: "done", startedAt: 0 }],
	]);
	const group = new CollapsedReadGroup(
		"read_file",
		[
			{ id: "a", args: { path: "src/foo.ts" } },
			{ id: "b", args: { path: "src/bar.ts" } },
		],
		tools,
	);

	it("renders 'Read 2 files' header when all done", () => {
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines[0]).toContain("Read 2 files");
	});
});
