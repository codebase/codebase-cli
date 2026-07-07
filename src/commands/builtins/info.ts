import { estimateContextTokens, messageChars } from "../../agent/context-estimate.js";
import { copyToClipboard } from "../../clipboard/copy.js";
import type { Command } from "../types.js";

export const help: Command = {
	name: "help",
	description: "List available slash commands and keyboard shortcuts.",
	handler: (_args, ctx) => {
		const lines: string[] = [];
		lines.push("Keyboard shortcuts:");
		lines.push("  /          slash-command autocomplete (Tab to complete, ↑↓ to choose)");
		lines.push("  !cmd       run a shell command directly (e.g. !git status)");
		lines.push("  @path      inline a file's contents into the next prompt");
		lines.push("  ↑/↓        recall prior prompts (at line start)");
		lines.push("  \\<Enter>   insert a newline instead of submitting");
		lines.push("  Ctrl-G     compose the current prompt in $EDITOR");
		lines.push("  Ctrl-O     copy a block from the transcript");
		lines.push("  Ctrl-R     reverse-search prior prompts");
		lines.push("  Ctrl-V     paste an image from the clipboard");
		lines.push("  Ctrl-C     cancel turn (busy) · twice to exit (idle)");
		lines.push("");
		lines.push("Slash commands:");
		for (const cmd of ctx.registry.list()) {
			const aliasPart = cmd.aliases?.length ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
			lines.push(`  /${cmd.name}${aliasPart} — ${cmd.description}`);
		}
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

export const whoami: Command = {
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

export const pwd: Command = {
	name: "pwd",
	aliases: ["cwd"],
	description: "Print the current working directory and copy it to the clipboard.",
	handler: async (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		const copied = await copyToClipboard(cwd).catch(() => false);
		ctx.emit(copied ? `${cwd}\n(copied to clipboard)` : cwd);
		return { handled: true };
	},
};

/**
 * Diagnostic for "the model isn't remembering what I told it earlier."
 * Compares the UI's display state (what the user sees in the transcript)
 * with the agent's internal _state.messages (what actually ships to the
 * model on the next turn). If those diverge, that's the bug. If they
 * match but the model still acts amnesiac, the issue is in the wire
 * call — pi-ai's openai-completions builder, the proxy, or the upstream.
 */
export const debug: Command = {
	name: "debug",
	description: "Inspect internal agent state — message count, token estimate, last few roles.",
	handler: (_args, ctx) => {
		const display = ctx.state.messages;
		const internal = ctx.bundle.agent.state.messages;
		const rolesTail = (msgs: readonly { role: string }[], n: number) =>
			msgs
				.slice(-n)
				.map((m) => m.role)
				.join(" → ") || "(empty)";
		const u = ctx.state.usage;
		const used = u.input + u.cacheRead;
		const compactAt = ctx.bundle.compaction.threshold();
		const divergent = display.length !== internal.length;
		const lines = [
			"Internal state inspection:",
			"",
			`  Display messages (UI):     ${display.length}`,
			`  Agent state messages:      ${internal.length}${divergent ? "  ← MISMATCH!" : ""}`,
			"",
			`  Last 5 display roles:      ${rolesTail(display, 5)}`,
			`  Last 5 agent state roles:  ${rolesTail(internal, 5)}`,
			"",
			`  Estimated tokens used:     ${used.toLocaleString()}`,
			`  Compaction triggers at:    ${compactAt.toLocaleString()}`,
			`  Streaming in progress:     ${ctx.state.streaming ? "yes" : "no"}`,
			"",
			divergent
				? "Mismatch means the agent and the UI disagree about what's been said. " +
					"That's the source of 'the model forgot' — the next turn ships internal " +
					"messages, not display messages. Report this with a `codebase --debug-input` " +
					"transcript so we can see how it happened."
				: "Display and agent state match. If the model is still acting amnesiac, the " +
					"context is leaving the CLI correctly but something on the wire is dropping " +
					"it — capture with OPENAI_LOG=debug codebase to see the raw HTTP request body.",
		];
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

export const context: Command = {
	name: "context",
	description: "Inspect context usage, compaction threshold, memory, tasks, and large messages.",
	handler: (_args, ctx) => {
		const used = estimateContextTokens(ctx.state);
		const usageReported = Boolean(
			ctx.state.turnUsage && ctx.state.turnUsage.input + ctx.state.turnUsage.cacheRead > 0,
		);
		const window = ctx.bundle.model.contextWindow ?? 200_000;
		const compactAt = ctx.bundle.compaction.threshold();
		const internal = ctx.bundle.agent.state.messages;
		const display = ctx.state.messages;
		const tasks = ctx.bundle.toolContext.tasks.list();
		const taskStats = summarizeTasks(tasks);
		const memoryIndex = ctx.bundle.memory.index();
		const memoryLines = memoryIndex ? memoryIndex.split("\n").filter((line) => line.trim()).length : 0;
		const memoryBytes = Buffer.byteLength(memoryIndex, "utf8");
		const tools = Array.from(ctx.state.tools.values());
		const toolErrors = tools.filter((t) => t.status === "error").length;
		const toolRunning = tools.filter((t) => t.status === "running").length;
		const compaction = ctx.bundle.compactionMonitor.current();
		const summaryCount = internal.filter(hasCompactionSummary).length;
		const largest = largestMessages(internal, 3);
		const lines = [
			"Context:",
			`  ${contextBar(used, window, compactAt)}`,
			`  used:       ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pct(used, window)})`,
			`  estimate:   ${usageReported ? "last model-reported input + streaming estimate" : "transcript estimate + static prompt budget"}`,
			`  compacts:   at ${compactAt.toLocaleString()} tokens (${pct(compactAt, window)})${
				compaction.active ? `; compacting ${compaction.messageCount} messages now` : ""
			}`,
			`  messages:   ${internal.length} agent / ${display.length} display (${roleCounts(internal)})`,
			`  summaries:  ${summaryCount} compaction summar${summaryCount === 1 ? "y" : "ies"} in context`,
			`  tasks:      ${taskStats.completed}/${taskStats.total} complete, ${taskStats.open} open, ${taskStats.cancelled} cancelled`,
			`  memory:     ${memoryLines} MEMORY.md index line${memoryLines === 1 ? "" : "s"} (${memoryBytes.toLocaleString()} bytes)`,
			`  tools:      ${tools.length} seen, ${toolRunning} running, ${toolErrors} error${toolErrors === 1 ? "" : "s"}`,
		];
		if (largest.length > 0) {
			lines.push("");
			lines.push("Largest messages:");
			for (const item of largest) {
				lines.push(`  #${item.index + 1} ${item.role}: ${item.tokens.toLocaleString()} est tokens`);
			}
		}
		lines.push("");
		lines.push(
			"Use /compact to summarize older context, /memory to inspect durable notes, and the task panel to inspect active work.",
		);
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

function contextBar(used: number, window: number, compactAt: number): string {
	const barWidth = 40;
	const ratio = Math.min(1, window > 0 ? used / window : 0);
	const compactRatio = Math.min(1, window > 0 ? compactAt / window : 0);
	const filled = Math.round(ratio * barWidth);
	const compactMark = Math.min(barWidth - 1, Math.max(0, Math.round(compactRatio * barWidth)));
	let bar = "";
	for (let i = 0; i < barWidth; i++) {
		if (i < filled) bar += "█";
		else if (i === compactMark) bar += "│";
		else bar += "░";
	}
	return bar;
}

function pct(value: number, total: number): string {
	if (total <= 0) return "0.0%";
	return `${((value / total) * 100).toFixed(1)}%`;
}

function summarizeTasks(tasks: readonly { status: string }[]): {
	total: number;
	completed: number;
	open: number;
	cancelled: number;
} {
	return {
		total: tasks.length,
		completed: tasks.filter((t) => t.status === "completed").length,
		open: tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
		cancelled: tasks.filter((t) => t.status === "cancelled").length,
	};
}

function roleCounts(messages: readonly { role: string }[]): string {
	const counts = new Map<string, number>();
	for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
	return [...counts.entries()].map(([role, count]) => `${role}:${count}`).join(", ");
}

function largestMessages(
	messages: Parameters<typeof messageChars>[0][],
	count: number,
): {
	index: number;
	role: string;
	tokens: number;
}[] {
	return messages
		.map((message, index) => ({ index, role: message.role, tokens: Math.round(messageChars(message) / 4) }))
		.filter((item) => item.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, count);
}

function hasCompactionSummary(message: Parameters<typeof messageChars>[0]): boolean {
	if (typeof message.content === "string") return message.content.includes("[Conversation compacted");
	if (!Array.isArray(message.content)) return false;
	return message.content.some((block) => block.type === "text" && block.text.includes("[Conversation compacted"));
}
