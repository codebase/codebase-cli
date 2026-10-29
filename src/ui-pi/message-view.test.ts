import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ToolExecution } from "../types.js";
import {
	attachesToPrevious,
	buildMessageBlocks,
	CollapsedReadGroup,
	formatReadSummary,
	PlainText,
	seedToolExecutions,
	ToolCallLine,
} from "./message-view.js";

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

	it("hides runtime reminders, DSML protocol, and thinking", () => {
		const user = buildMessageBlocks(
			userText("<system-reminder>internal</system-reminder>Actual request"),
			NO_TOOLS,
			"user",
		);
		expect((user[0] as PlainText).render(80).join("\n")).toBe("Actual request");

		const assistant = buildMessageBlocks(
			assistantBlocks([
				{ type: "thinking", thinking: "private repair narration" },
				{ type: "text", text: "Visible answer<｜DSML｜hidden protocol" },
			]),
			NO_TOOLS,
			"assistant",
		);
		expect(assistant).toHaveLength(1);
		expect(assistant[0]?.render(80).join("\n")).toContain("Visible answer");
		expect(assistant[0]?.render(80).join("\n")).not.toContain("DSML");
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

describe("formatReadSummary", () => {
	const text = (s: string) => [{ type: "text", text: s }];

	it("shows how many lines and which range for a partial read", () => {
		const details = { totalLines: 75, returnedLines: 50, startLine: 20, endLine: 69 };
		expect(formatReadSummary(details, text(""))).toBe("50 lines · 20–69 of 75");
	});

	it("marks a whole-file read", () => {
		const details = { totalLines: 52, returnedLines: 52, startLine: 1, endLine: 52 };
		expect(formatReadSummary(details, text(""))).toBe("52 lines · 1–52 (whole file)");
	});

	it("recovers the range from numbered output in older sessions", () => {
		const details = { totalLines: 75, returnedLines: 2 };
		expect(formatReadSummary(details, text("    50→a\n    51→b\n... (showing lines 50-51 of 75)"))).toBe(
			"2 lines · 50–51 of 75",
		);
	});

	it("handles empty files and images", () => {
		expect(formatReadSummary({ totalLines: 0, returnedLines: 0 }, text(""))).toBe("Empty file");
		expect(formatReadSummary({ isImage: true }, [])).toBe("Read image");
	});
});

describe("attachesToPrevious", () => {
	const result = (toolName: string, isError: boolean): AgentMessage => ({
		role: "toolResult",
		toolCallId: "t1",
		toolName,
		content: [],
		isError,
		timestamp: 0,
	});

	it("joins successful reads to their tool call, nothing else", () => {
		expect(attachesToPrevious(result("read_file", false))).toBe(true);
		expect(attachesToPrevious(result("read_file", true))).toBe(false);
		expect(attachesToPrevious(result("shell", false))).toBe(false);
	});
});

describe("file-edit previews wait for confirmed completion", () => {
	const strip = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
	const done = (id: string, name: string, args: unknown): ToolExecution => ({
		id,
		name,
		args,
		status: "done",
		startedAt: 0,
	});

	it("does not cache a streaming preview: the completed write shows the final content", () => {
		const id = "stream-write-1";
		const streaming = new ToolCallLine(id, "write_file", { path: "a.txt", content: "first" }, NO_TOOLS);
		expect(strip(streaming.render(80).join("\n"))).not.toContain("Wrote");

		const final = { path: "a.txt", content: "first\nsecond\nthird\n" };
		const tools = new Map([[id, done(id, "write_file", final)]]);
		const out = strip(new ToolCallLine(id, "write_file", final, tools).render(80).join("\n"));
		expect(out).toContain("Wrote 3 lines");
		expect(out).toContain("3 + third");
	});

	it("does not read the target file for an edit that hasn't run yet", () => {
		const dir = mkdtempSync(join(tmpdir(), "pending-edit-"));
		const file = join(dir, "f.txt");
		writeFileSync(file, "one\ntwo\n");
		const id = "pending-edit-1";
		const args = { path: file, old_string: "two", new_string: "TWO" };
		expect(strip(new ToolCallLine(id, "edit_file", args, NO_TOOLS).render(80).join("\n"))).not.toContain("Update(");

		writeFileSync(file, "one\nTWO\n");
		const tools = new Map([[id, done(id, "edit_file", args)]]);
		const out = strip(new ToolCallLine(id, "edit_file", args, tools).render(80).join("\n"));
		expect(out).toContain("2 + TWO");
	});

	it("seeds executions for resumed calls from their saved results", () => {
		const tools = new Map<string, ToolExecution>();
		const call = (id: string) => ({ type: "toolCall" as const, id, name: "write_file", arguments: { path: "x" } });
		const result = (id: string, isError: boolean): AgentMessage => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "write_file",
			content: [],
			isError,
			timestamp: 1,
		});
		seedToolExecutions(tools, [
			assistantBlocks([call("ok"), call("bad"), call("never-ran")]),
			result("ok", false),
			result("bad", true),
		]);
		expect(tools.get("ok")?.status).toBe("done");
		expect(tools.get("bad")?.status).toBe("error");
		expect(tools.has("never-ran")).toBe(false);
	});
});
