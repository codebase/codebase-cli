import { estimateContextTokens, messageChars, STATIC_CONTEXT_TOKENS } from "../../agent/context-estimate.js";
import { copyToClipboard } from "../../clipboard/copy.js";
import { findRelevantMemories, isMemoryStale, type RelevantMemoryMatch } from "../../memory/inject.js";
import type { MemoryRecord } from "../../memory/types.js";
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
				? "signed in via codebase.design (inference proxy)"
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
	aliases: ["ctx"],
	description:
		"Inspect context usage, compaction threshold, memory, tasks, and large messages. Use /context explain for detail.",
	handler: (args, ctx) => {
		const mode = args.trim().toLowerCase();
		if (mode === "explain" || mode === "why") {
			ctx.emit(renderContextExplanation(ctx));
			return { handled: true };
		}
		if (mode && mode !== "summary") {
			ctx.emit("Usage: /context [explain]");
			return { handled: true };
		}
		const snapshot = contextSnapshot(ctx);
		const lines = [
			"Context:",
			`  model:      ${snapshot.modelLabel}`,
			...(snapshot.cwd ? [`  cwd:        ${snapshot.cwd}`] : []),
			`  ${contextBar(snapshot.used, snapshot.window, snapshot.compactAt)}`,
			`  used:       ${snapshot.used.toLocaleString()} / ${snapshot.window.toLocaleString()} tokens (${pct(snapshot.used, snapshot.window)})`,
			`  estimate:   ${snapshot.usageReported ? "last model-reported input + streaming estimate" : "transcript estimate + static prompt budget"}`,
			`  compacts:   at ${snapshot.compactAt.toLocaleString()} tokens (${pct(snapshot.compactAt, snapshot.window)})${
				snapshot.compaction.active ? `; compacting ${snapshot.compaction.messageCount} messages now` : ""
			}`,
			`  pressure:   ${contextPressure(snapshot)}`,
			`  why:        ${contextPressureReasons(snapshot).slice(0, 2).join("; ")}`,
			`  messages:   ${snapshot.internal.length} agent / ${snapshot.display.length} display (${roleCounts(snapshot.internal)})`,
			`  summaries:  ${snapshot.summaryCount} compaction summar${snapshot.summaryCount === 1 ? "y" : "ies"} in context`,
			`  tasks:      ${snapshot.taskStats.completed}/${snapshot.taskStats.total} complete, ${snapshot.taskStats.open} open, ${snapshot.taskStats.cancelled} cancelled`,
			`  memory:     ${formatMemorySummary(snapshot)}`,
			`  tools:      ${snapshot.tools.length} seen, ${snapshot.toolRunning} running, ${snapshot.toolErrors} error${snapshot.toolErrors === 1 ? "" : "s"}`,
		];
		if (snapshot.lastSummary) {
			lines.push(`  last summary: ${truncateOneLine(snapshot.lastSummary, 96)}`);
		}
		if (snapshot.largest.length > 0) {
			lines.push("");
			lines.push("Largest messages:");
			for (const item of snapshot.largest) {
				lines.push(`  #${item.index + 1} ${item.role}: ${item.tokens.toLocaleString()} est tokens`);
			}
		}
		lines.push("");
		lines.push(
			"Use /context explain for details, /compact to summarize older context, /memory to inspect durable notes, and the task panel to inspect active work.",
		);
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

type ContextCommandContext = Parameters<Command["handler"]>[1];
type ContextMessage = Parameters<typeof messageChars>[0];

function renderContextExplanation(ctx: ContextCommandContext): string {
	const snapshot = contextSnapshot(ctx);
	const remainingToCompact = snapshot.compactAt - snapshot.used;
	const lines = [
		"Context explanation:",
		"",
		"Budget:",
		`  model: ${snapshot.modelLabel}`,
		...(snapshot.cwd ? [`  cwd: ${snapshot.cwd}`] : []),
		`  ${snapshot.used.toLocaleString()} / ${snapshot.window.toLocaleString()} tokens used (${pct(snapshot.used, snapshot.window)})`,
		`  compaction threshold: ${snapshot.compactAt.toLocaleString()} tokens (${remainingToCompact > 0 ? `${remainingToCompact.toLocaleString()} left` : `${Math.abs(remainingToCompact).toLocaleString()} over`})`,
		`  pressure: ${contextPressure(snapshot.used, snapshot.window, snapshot.compactAt)}`,
		`  estimate source: ${
			snapshot.usageReported
				? "provider-reported input/cache plus streaming estimate"
				: "local transcript estimate plus static prompt budget"
		}`,
		`  static prompt/tool/memory-index budget: about ${STATIC_CONTEXT_TOKENS.toLocaleString()} tokens`,
		"",
		"Top context contributors:",
	];
	if (snapshot.largest.length === 0) {
		lines.push("  No large transcript messages yet; static prompt, tools, and memory index dominate.");
	} else {
		for (const item of snapshot.largest) {
			lines.push(
				`  #${item.index + 1} ${item.role}: ${item.tokens.toLocaleString()} est tokens - ${messagePreview(item.message, 110)}`,
			);
		}
	}
	lines.push("");
	lines.push("Recent messages still in context:");
	for (const item of recentMessages(snapshot.internal, 5)) {
		lines.push(`  #${item.index + 1} ${item.role}: ${messagePreview(item.message, 90)}`);
	}
	if (snapshot.internal.length === 0) lines.push("  none");
	lines.push("");
	lines.push("Tasks:");
	if (snapshot.openTasks.length === 0) {
		lines.push("  Open tasks: none");
	} else {
		lines.push("  Open tasks:");
		for (const task of snapshot.openTasks.slice(0, 6)) lines.push(`    ${formatTaskLine(task)}`);
		if (snapshot.openTasks.length > 6) lines.push(`    ...and ${snapshot.openTasks.length - 6} more`);
	}
	lines.push("");
	lines.push("Memory:");
	lines.push(
		`  MEMORY.md index: ${snapshot.memoryLines} line${snapshot.memoryLines === 1 ? "" : "s"} (${snapshot.memoryBytes.toLocaleString()} bytes) injected at launch.`,
	);
	if (snapshot.memoryRecords.length === 0) {
		lines.push("  Available memory files: none");
	} else {
		lines.push(
			`  Available memory files: ${snapshot.memoryRecords.length} (${memoryTypeSummary(snapshot.memoryRecords) || "uncategorized"})`,
		);
		for (const record of snapshot.memoryRecords.slice(0, 6)) lines.push(`    ${formatMemoryRecordLine(record)}`);
		if (snapshot.memoryRecords.length > 6) lines.push(`    ...and ${snapshot.memoryRecords.length - 6} more`);
	}
	if (!snapshot.latestUserPrompt) {
		lines.push("  Matching latest prompt: none (no user prompt in agent context yet)");
	} else if (snapshot.relevantMemories.length === 0) {
		lines.push("  Matching latest prompt: none; full memory bodies would not be recalled for the current prompt.");
	} else {
		lines.push("  Matching latest prompt (would be recalled on the next model turn):");
		for (const match of snapshot.relevantMemories) lines.push(`    ${formatRelevantMemoryLine(match)}`);
	}
	if (snapshot.retainedMemoryReminders.length === 0) {
		lines.push("  Memory reminder messages retained: none detected; prompt-time reminders are usually transient.");
	} else {
		lines.push("  Memory reminder messages retained in transcript:");
		for (const reminder of snapshot.retainedMemoryReminders.slice(0, 6)) {
			lines.push(
				`    ${reminder.filename} [${reminder.type || "unknown"}; source: ${truncateOneLine(reminder.source || "unknown", 54)}]`,
			);
		}
		if (snapshot.retainedMemoryReminders.length > 6) {
			lines.push(`    ...and ${snapshot.retainedMemoryReminders.length - 6} more`);
		}
	}
	lines.push("");
	lines.push("Compaction:");
	if (snapshot.lastSummary) {
		lines.push(`  Last summary: ${truncateOneLine(snapshot.lastSummary, 180)}`);
	} else {
		lines.push("  No full compaction summary is currently in the transcript.");
	}
	lines.push("  Microcompaction may still clear old read/grep/list tool results before full summarization.");
	lines.push("");
	lines.push("Attached/imported files detected:");
	if (snapshot.inlineFiles.length === 0) {
		lines.push("  none detected in current transcript");
	} else {
		for (const file of snapshot.inlineFiles.slice(0, 8)) lines.push(`  ${file}`);
		if (snapshot.inlineFiles.length > 8) lines.push(`  ...and ${snapshot.inlineFiles.length - 8} more`);
	}
	lines.push("");
	lines.push("What is at risk:");
	for (const risk of contextRisks(snapshot)) lines.push(`  ${risk}`);
	lines.push("");
	lines.push("Why pressure is this level:");
	for (const reason of contextPressureReasons(snapshot)) lines.push(`  ${reason}`);
	lines.push("");
	lines.push("Good next moves:");
	for (const action of contextActions(snapshot)) lines.push(`  ${action}`);
	return lines.join("\n");
}

function contextSnapshot(ctx: ContextCommandContext) {
	const used = estimateContextTokens(ctx.state);
	const usageReported = Boolean(ctx.state.turnUsage && ctx.state.turnUsage.input + ctx.state.turnUsage.cacheRead > 0);
	const window = ctx.bundle.model.contextWindow ?? 200_000;
	const compactAt = ctx.bundle.compaction.threshold();
	const cwd = stringProp(ctx.bundle.toolContext, "cwd");
	const modelName = ctx.bundle.model.name || ctx.state.model?.name || ctx.bundle.model.id;
	const modelProvider = ctx.bundle.model.provider || ctx.state.model?.provider || "unknown";
	const modelId = ctx.bundle.model.id || ctx.state.model?.id || "unknown";
	const internal = ctx.bundle.agent.state.messages;
	const display = ctx.state.messages;
	const tasks = ctx.bundle.toolContext.tasks.list();
	const taskStats = summarizeTasks(tasks);
	const openTasks = tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const memoryIndex = ctx.bundle.memory.index();
	const memoryLines = memoryIndex ? memoryIndex.split("\n").filter((line) => line.trim()).length : 0;
	const memoryBytes = Buffer.byteLength(memoryIndex, "utf8");
	const memoryRecords = ctx.bundle.memory.list();
	const latestUserPrompt = latestRealUserMessageText(internal);
	const relevantMemories = latestUserPrompt ? findRelevantMemories(ctx.bundle.memory, latestUserPrompt) : [];
	const retainedMemoryReminders = detectMemoryReminders(internal);
	const tools = Array.from(ctx.state.tools.values());
	const toolErrors = tools.filter((t) => t.status === "error").length;
	const toolRunning = tools.filter((t) => t.status === "running").length;
	const compaction = ctx.bundle.compactionMonitor.current();
	const summaries = compactionSummaries(internal);
	return {
		used,
		usageReported,
		window,
		compactAt,
		cwd,
		modelLabel: `${modelName} (${modelProvider}/${modelId})`,
		internal,
		display,
		tasks,
		taskStats,
		openTasks,
		memoryLines,
		memoryBytes,
		memoryRecords,
		latestUserPrompt,
		relevantMemories,
		retainedMemoryReminders,
		tools,
		toolErrors,
		toolRunning,
		compaction,
		summaryCount: summaries.length,
		lastSummary: summaries.at(-1) ?? null,
		largest: largestMessages(internal, 5),
		inlineFiles: detectInlineFiles(internal),
	};
}

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

function formatMemorySummary(snapshot: ReturnType<typeof contextSnapshot>): string {
	const index = `${snapshot.memoryLines} MEMORY.md index line${snapshot.memoryLines === 1 ? "" : "s"} (${snapshot.memoryBytes.toLocaleString()} bytes)`;
	const files = `${snapshot.memoryRecords.length} memory file${snapshot.memoryRecords.length === 1 ? "" : "s"}`;
	const types = memoryTypeSummary(snapshot.memoryRecords);
	const parts = [index, types ? `${files} (${types})` : files];
	if (snapshot.relevantMemories.length > 0) {
		parts.push(
			`${snapshot.relevantMemories.length} matching latest prompt${snapshot.relevantMemories.length === 1 ? "" : "s"}`,
		);
	}
	if (snapshot.retainedMemoryReminders.length > 0) {
		parts.push(
			`${snapshot.retainedMemoryReminders.length} reminder file${snapshot.retainedMemoryReminders.length === 1 ? "" : "s"} retained`,
		);
	}
	return parts.join(", ");
}

function memoryTypeSummary(records: readonly MemoryRecord[]): string {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
	const order = ["user", "feedback", "project", "reference"];
	return [...counts.entries()]
		.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || a[0].localeCompare(b[0]))
		.map(([type, count]) => `${type}:${count}`)
		.join(", ");
}

function formatMemoryRecordLine(record: MemoryRecord): string {
	const stale = isMemoryStale(record) ? "yes" : "no";
	const label = truncateOneLine(`${record.name} - ${record.description}`, 96);
	const source = truncateOneLine(record.source, 54);
	const bodyBytes = Buffer.byteLength(record.body, "utf8").toLocaleString();
	return `${record.filename} [${record.type}; source: ${source}; updated: ${formatShortDate(record.updatedAt)}; last used: ${formatOptionalShortDate(record.lastUsedAt)}; retrievals: ${record.retrievalCount}; stale: ${stale}] ${label} (${bodyBytes} bytes)`;
}

function formatRelevantMemoryLine(match: RelevantMemoryMatch): string {
	const record = match.record;
	const label = truncateOneLine(record.name, 72);
	const source = truncateOneLine(record.source, 54);
	const terms = match.matchedTerms.length > 0 ? ` terms:${match.matchedTerms.join(",")}` : "";
	const fields = match.matchedFields.length > 0 ? ` fields:${match.matchedFields.join(",")}` : "";
	return `${record.filename} score:${match.score}${terms}${fields} [${record.type}; source: ${source}; last used: ${formatOptionalShortDate(record.lastUsedAt)}; retrievals: ${record.retrievalCount}; stale: ${match.stale ? "yes" : "no"}] ${label}`;
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
	message: ContextMessage;
}[] {
	return messages
		.map((message, index) => ({
			index,
			role: message.role,
			tokens: Math.round(messageChars(message) / 4),
			message,
		}))
		.filter((item) => item.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, count);
}

function compactionSummaries(messages: readonly ContextMessage[]): string[] {
	return messages.map(compactionSummaryText).filter((summary): summary is string => summary !== null);
}

function compactionSummaryText(message: ContextMessage): string | null {
	const text = messageText(message);
	const marker = "[Conversation compacted";
	const idx = text.indexOf(marker);
	if (idx === -1) return null;
	const after = text.slice(idx + marker.length);
	const firstBreak = after.indexOf("\n");
	const summary = firstBreak === -1 ? after : after.slice(firstBreak + 1);
	return summary.trim() || text.slice(idx).trim();
}

function recentMessages(
	messages: readonly ContextMessage[],
	count: number,
): Array<{
	index: number;
	role: string;
	message: ContextMessage;
}> {
	return messages.slice(-count).map((message, offset) => ({
		index: messages.length - Math.min(count, messages.length) + offset,
		role: message.role,
		message,
	}));
}

function contextPressure(
	input: number | ReturnType<typeof contextSnapshot>,
	window?: number,
	compactAt?: number,
): string {
	const used = typeof input === "number" ? input : input.used;
	const resolvedWindow = typeof input === "number" ? (window ?? 0) : input.window;
	const resolvedCompactAt = typeof input === "number" ? (compactAt ?? resolvedWindow) : input.compactAt;
	const remaining = resolvedCompactAt - used;
	const ratioToCompact = resolvedCompactAt > 0 ? used / resolvedCompactAt : 0;
	if (used >= resolvedCompactAt) return "over compaction threshold; the next turn may summarize older context";
	if (remaining <= Math.max(1_000, resolvedCompactAt * 0.05)) {
		return `high; within ${remaining.toLocaleString()} tokens of compaction`;
	}
	if (ratioToCompact >= 0.85) return "high; close to compaction threshold";
	if (ratioToCompact >= 0.6) return "moderate; large tool results and attachments are worth watching";
	return "low; transcript still has plenty of room";
}

function contextRisks(snapshot: ReturnType<typeof contextSnapshot>): string[] {
	const risks: string[] = [];
	if (snapshot.used >= snapshot.compactAt) {
		risks.push("Older detailed messages are eligible for full compaction on the next model turn.");
	} else if (snapshot.used / snapshot.window >= 0.75) {
		risks.push(
			"Large file reads, grep output, shell output, and attachments are the first things likely to pressure context.",
		);
	} else {
		risks.push("No immediate context pressure; static prompt/tool schemas are the main fixed cost.");
	}
	if (snapshot.openTasks.length > 0) {
		risks.push(
			"Open task titles persist in the task store, but details buried only in chat can still be summarized.",
		);
	}
	if (snapshot.memoryRecords.length > 0) {
		risks.push(
			"Memory bodies are selected by latest-prompt relevance; stale or unmatched notes still need explicit /memory inspection.",
		);
	}
	if (snapshot.inlineFiles.length > 0) {
		risks.push(
			"Inline @file attachments stay as transcript text until compaction; reattach files if exact contents matter later.",
		);
	}
	return risks;
}

function contextPressureReasons(snapshot: ReturnType<typeof contextSnapshot>): string[] {
	const reasons: string[] = [];
	const remaining = snapshot.compactAt - snapshot.used;
	const ratioToCompact = snapshot.compactAt > 0 ? snapshot.used / snapshot.compactAt : 0;
	if (remaining <= 0) {
		reasons.push(`${Math.abs(remaining).toLocaleString()} tokens over the compaction threshold`);
	} else {
		reasons.push(
			`${remaining.toLocaleString()} tokens until compaction (${pct(snapshot.used, snapshot.compactAt)} of threshold used)`,
		);
	}
	if (snapshot.usageReported) {
		reasons.push("estimate comes from provider-reported input/cache, so it reflects the last real model call");
	} else {
		reasons.push("estimate is local because no provider token report is available yet");
	}
	const largest = snapshot.largest[0];
	if (largest && (largest.tokens >= 500 || ratioToCompact >= 0.6)) {
		reasons.push(
			`largest retained message is #${largest.index + 1} ${largest.role} at ${largest.tokens.toLocaleString()} est tokens`,
		);
	}
	const toolResults = toolResultStats(snapshot.internal);
	if (toolResults.count > 0) {
		reasons.push(
			`${toolResults.count} tool result message${toolResults.count === 1 ? "" : "s"} retained (${toolResults.tokens.toLocaleString()} est tokens)`,
		);
	}
	if (snapshot.inlineFiles.length > 0) {
		reasons.push(
			`${snapshot.inlineFiles.length} inline/imported file${snapshot.inlineFiles.length === 1 ? "" : "s"} in transcript`,
		);
	}
	if (snapshot.summaryCount > 0) {
		reasons.push(
			`${snapshot.summaryCount} prior compaction summar${snapshot.summaryCount === 1 ? "y" : "ies"} already retained`,
		);
	}
	if (snapshot.relevantMemories.length > 0) {
		reasons.push(
			`${snapshot.relevantMemories.length} memory bod${snapshot.relevantMemories.length === 1 ? "y" : "ies"} match the latest prompt`,
		);
	}
	return reasons;
}

function contextActions(snapshot: ReturnType<typeof contextSnapshot>): string[] {
	const actions: string[] = [];
	const ratioToCompact = snapshot.compactAt > 0 ? snapshot.used / snapshot.compactAt : 0;
	if (snapshot.used >= snapshot.compactAt || ratioToCompact >= 0.85) {
		actions.push("Run /compact before starting a long or delicate change.");
	}
	const toolResults = toolResultStats(snapshot.internal);
	if (toolResults.count > 0) {
		actions.push("Prefer a fresh narrow read/grep over relying on old bulky tool output.");
	}
	if (snapshot.inlineFiles.length > 0) {
		actions.push("Reattach @files if exact contents matter after compaction.");
	}
	if (snapshot.relevantMemories.length > 0) {
		actions.push("Use /memory or read_memory when a matched memory needs exact provenance or full body text.");
	}
	if (snapshot.openTasks.length > 0) {
		actions.push("Keep active work in tasks; details buried only in chat are easier to lose during summarization.");
	}
	if (actions.length === 0) actions.push("No immediate action needed; context pressure is low.");
	return actions;
}

function toolResultStats(messages: readonly ContextMessage[]): { count: number; tokens: number } {
	let count = 0;
	let tokens = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		count++;
		tokens += Math.round(messageChars(message) / 4);
	}
	return { count, tokens };
}

function stringProp(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object") return null;
	const out = (value as Record<string, unknown>)[key];
	return typeof out === "string" && out.trim() ? out : null;
}

function detectInlineFiles(messages: readonly ContextMessage[]): string[] {
	const files = new Set<string>();
	for (const message of messages) {
		const text = messageText(message);
		if (!text) continue;
		for (const match of text.matchAll(/^### ([^\n]+)$/gm)) {
			if (text.includes("Attached files (auto-inlined from @ mentions):")) files.add(match[1].trim());
		}
		for (const match of text.matchAll(/<!-- imported from ([^>]+) -->/g)) {
			files.add(match[1].trim());
		}
	}
	return [...files].filter(Boolean).sort();
}

interface RetainedMemoryReminder {
	filename: string;
	type: string;
	source: string;
}

function detectMemoryReminders(messages: readonly ContextMessage[]): RetainedMemoryReminder[] {
	const reminders = new Map<string, RetainedMemoryReminder>();
	for (const message of messages) {
		const text = messageText(message);
		if (!text.includes("Relevant project memories for this prompt")) continue;
		for (const match of text.matchAll(/^\s*file:\s*([^;]+);\s*type:\s*([^;]+);\s*source:\s*([^;\n]+)/gm)) {
			const filename = match[1]?.trim() ?? "";
			if (!filename) continue;
			const type = match[2]?.trim() ?? "";
			const source = match[3]?.trim() ?? "";
			reminders.set(`${filename}\0${type}\0${source}`, { filename, type, source });
		}
	}
	return [...reminders.values()].sort((a, b) => a.filename.localeCompare(b.filename));
}

function latestRealUserMessageText(messages: readonly ContextMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = messageText(message).trim();
		if (!text || text.startsWith("<system-reminder>")) continue;
		if (text.startsWith("[Conversation compacted")) continue;
		return text;
	}
	return null;
}

function formatTaskLine(task: {
	id?: string;
	title?: string;
	status: string;
	owner?: string | null;
	blockedBy?: readonly string[];
}): string {
	const title = task.title?.trim() || "(untitled task)";
	const owner = task.owner ? ` owner:${task.owner}` : "";
	const blockers = task.blockedBy && task.blockedBy.length > 0 ? ` blocked_by:${task.blockedBy.join(",")}` : "";
	return `${task.id ? `${task.id} ` : ""}${title} [${task.status}${owner}${blockers}]`;
}

function formatShortDate(ms: number): string {
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown";
}

function formatOptionalShortDate(ms?: number): string {
	return ms ? formatShortDate(ms) : "never";
}

function messagePreview(message: ContextMessage, maxChars: number): string {
	const calls = toolCallNames(message);
	if (calls.length > 0) return truncateOneLine(`tool calls: ${calls.join(", ")}`, maxChars);
	const toolName =
		message.role === "toolResult" && "toolName" in message && typeof message.toolName === "string"
			? `${message.toolName} result: `
			: "";
	return truncateOneLine(`${toolName}${messageText(message) || "(no text)"}`, maxChars);
}

function toolCallNames(message: ContextMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const names: string[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const name = (block as { name?: unknown }).name;
		if (typeof name === "string") names.push(name);
	}
	return names;
}

function messageText(message: ContextMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
	}
	return parts.join("\n");
}

function truncateOneLine(value: string, maxChars: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxChars) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
