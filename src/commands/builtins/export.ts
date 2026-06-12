import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { copyToClipboard } from "../../clipboard/copy.js";
import type { Command } from "../types.js";

/**
 * /export — render the conversation as markdown. No args copies it to
 * the clipboard; with a path it writes a file. Tool calls are summarized
 * as one-liners; tool results are omitted (they're huge and rarely what
 * a shared transcript needs).
 */
export const exportCmd: Command = {
	name: "export",
	description: "Export the conversation as markdown. /export = clipboard; /export <path> = file.",
	handler: async (args, ctx) => {
		if (ctx.state.messages.length === 0) {
			ctx.emit("nothing to export — no messages yet.");
			return { handled: true };
		}
		const markdown = renderTranscript(ctx.state.messages, ctx.state.model.name);

		const target = args.trim();
		if (target) {
			const path = isAbsolute(target) ? target : resolve(ctx.bundle.toolContext.cwd, target);
			try {
				writeFileSync(path, markdown, "utf8");
				ctx.emit(`exported ${ctx.state.messages.length} messages to ${path}`);
			} catch (err) {
				ctx.emit(`export failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return { handled: true };
		}

		try {
			const result = await copyToClipboard(markdown);
			const note = result.truncated
				? ` (truncated to ${result.bytes} bytes — use /export <path> for the full transcript)`
				: "";
			ctx.emit(`exported ${ctx.state.messages.length} messages to the clipboard via ${result.method}${note}.`);
		} catch (err) {
			ctx.emit(
				`clipboard unavailable (${err instanceof Error ? err.message : String(err)}) — use /export <path> instead.`,
			);
		}
		return { handled: true };
	},
};

function renderTranscript(messages: readonly AgentMessage[], modelName: string): string {
	const lines: string[] = [
		`# codebase session`,
		"",
		`Model: ${modelName} · Exported: ${new Date().toISOString()}`,
		"",
	];
	for (const m of messages) {
		if (m.role === "user") {
			const text = extractText(m.content);
			if (!text) continue; // tool results / reminders aren't part of the dialogue
			lines.push("## User", "", text, "");
		} else if (m.role === "assistant") {
			const text = extractText(m.content);
			const calls = extractToolCalls(m.content);
			if (!text && calls.length === 0) continue;
			lines.push("## Assistant", "");
			if (text) lines.push(text, "");
			for (const c of calls) lines.push(`> 🔧 ${c}`);
			if (calls.length > 0) lines.push("");
		}
	}
	return lines.join("\n");
}

function extractText(content: AgentMessage["content"]): string {
	if (typeof content === "string") {
		return stripReminders(content);
	}
	if (!Array.isArray(content)) return "";
	return stripReminders(
		content
			.filter(
				(b): b is { type: "text"; text: string } =>
					b.type === "text" && typeof (b as { text?: unknown }).text === "string",
			)
			.map((b) => b.text)
			.join("\n"),
	);
}

function extractToolCalls(content: AgentMessage["content"]): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (block.type !== "toolCall") continue;
		const call = block as { name?: string; arguments?: Record<string, unknown> };
		const arg = call.arguments?.path ?? call.arguments?.command ?? call.arguments?.task ?? "";
		out.push(`${call.name ?? "tool"}${arg ? ` — ${String(arg).slice(0, 80)}` : ""}`);
	}
	return out;
}

function stripReminders(text: string): string {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}
