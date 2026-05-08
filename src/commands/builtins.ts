import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { copyToClipboard, extractLastCodeBlock } from "../clipboard/copy.js";
import type { Command } from "./types.js";

const help: Command = {
	name: "help",
	description: "List available slash commands.",
	handler: (_args, ctx) => {
		const lines: string[] = ["available slash commands:"];
		const reg = (ctx as unknown as { registry?: { list: () => Command[] } }).registry;
		// builtins() is built before registry is constructed, so the registry
		// reference is injected via ctx by the App. If absent (e.g. in tests),
		// we print just this message.
		if (reg) {
			for (const cmd of reg.list()) {
				const aliasPart = cmd.aliases?.length ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
				lines.push(`  /${cmd.name}${aliasPart} — ${cmd.description}`);
			}
		}
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

const clear: Command = {
	name: "clear",
	description: "Clear the on-screen chat history. (Agent context is preserved.)",
	mutates: true,
	handler: (_args, ctx) => {
		ctx.clearDisplay();
		return { handled: true };
	},
};

const compact: Command = {
	name: "compact",
	description: "Force a compaction pass on the running transcript.",
	mutates: true,
	handler: async (_args, ctx) => {
		const messages = ctx.bundle.agent.state.messages;
		const result = await ctx.bundle.compaction.compact(messages);
		if (result.details.collapsedMessageCount === 0) {
			ctx.emit("nothing to compact yet — transcript is short.");
			return { handled: true };
		}
		ctx.bundle.agent.state.messages = result.messages;
		ctx.emit(
			`compacted ${result.details.collapsedMessageCount} messages (~${result.details.truncatedTokens} tokens). ` +
				`${result.details.modifiedFiles.length} files modified, ${result.details.readFiles.length} read are preserved in the summary.`,
		);
		return { handled: true };
	},
};

const session: Command = {
	name: "session",
	aliases: ["info"],
	description: "Show session stats (model, usage, message count).",
	handler: (_args, ctx) => {
		const { state, bundle } = ctx;
		const u = state.usage;
		const lines = [
			`model:    ${state.model.provider}/${state.model.id} (${state.model.name})`,
			`messages: ${state.messages.length}`,
			`usage:    ↓${u.input} ↑${u.output} cache ↓${u.cacheRead}/↑${u.cacheWrite}`,
			`cost:     $${u.cost.total.toFixed(4)}`,
			`source:   ${bundle.source}`,
		];
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

const modelCmd: Command = {
	name: "model",
	description: "Show the current model.",
	handler: (_args, ctx) => {
		const m = ctx.state.model;
		ctx.emit(`${m.provider}/${m.id} (${m.name})`);
		return { handled: true };
	},
};

const whoami: Command = {
	name: "whoami",
	aliases: ["status"],
	description: "Show current sign-in status.",
	handler: (_args, ctx) => {
		const source = ctx.bundle.source;
		ctx.emit(
			source === "proxy"
				? "signed in via codebase.foundation (inference proxy)"
				: source === "explicit"
					? "using model selected via CODEBASE_PROVIDER + CODEBASE_MODEL"
					: "using auto-detected provider from env",
		);
		return { handled: true };
	},
};

const exit: Command = {
	name: "exit",
	aliases: ["quit"],
	description: "Quit codebase.",
	handler: (_args, ctx) => {
		ctx.exit();
		return { handled: true };
	},
};

const copy: Command = {
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

export const BUILTIN_COMMANDS: readonly Command[] = [help, clear, compact, session, modelCmd, whoami, copy, exit];
