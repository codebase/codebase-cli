import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { copyToClipboard, extractLastCodeBlock } from "../../clipboard/copy.js";
import type { Command } from "../types.js";

export const copy: Command = {
	name: "copy",
	description:
		"Copy text to the system clipboard. /copy = last assistant message; /copy code = last code block; /copy <N> = message N.",
	handler: async (args, ctx) => {
		const messages = ctx.state.messages;
		const target = resolveCopyTarget(args, messages);
		if (target === null) {
			ctx.emit("no assistant messages yet to copy.");
			return { handled: true };
		}
		if (!target.text) {
			ctx.emit("could not find text to copy. Try /copy, /copy code, or /copy <N>.");
			return { handled: true };
		}
		try {
			const result = await copyToClipboard(target.text);
			const truncatedNote = result.truncated ? `, truncated to ${result.bytes}` : ` (${result.bytes} bytes)`;
			ctx.emit(`copied ${target.label} via ${result.method}${truncatedNote}`);
		} catch (err) {
			ctx.emit(`/copy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

interface CopyTarget {
	text: string;
	label: string;
}

function resolveCopyTarget(args: string, messages: readonly AgentMessage[]): CopyTarget | null {
	const trimmed = args.trim().toLowerCase();
	if (trimmed === "code") {
		const last = lastAssistantText(messages);
		if (!last) return null;
		const block = extractLastCodeBlock(last);
		if (!block) return { text: "", label: "" };
		return { text: block, label: "last code block" };
	}
	if (/^\d+$/.test(trimmed)) {
		const idx = Number.parseInt(trimmed, 10) - 1;
		if (idx < 0 || idx >= messages.length) return { text: "", label: "" };
		const msg = messages[idx];
		const text = extractText(msg);
		if (!text) return { text: "", label: "" };
		return { text, label: `message ${idx + 1}` };
	}
	const last = lastAssistantText(messages);
	if (!last) return null;
	return { text: last, label: "last assistant message" };
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = extractText(m);
		if (text) return text;
	}
	return "";
}

function extractText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content as Array<{ type: string; text?: string }>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}
