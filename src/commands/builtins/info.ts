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
	description: "Visualize how full the context window is right now.",
	handler: (_args, ctx) => {
		const u = ctx.state.usage;
		const used = u.input + u.cacheRead;
		// Anthropic Claude Sonnet 4.x is 200K input by default; Opus is 200K too.
		// pi-ai's model.contextLength would be the source of truth; for now use
		// 200K as the floor and clamp.
		const window = (ctx.state.model as { contextLength?: number }).contextLength ?? 200_000;
		const ratio = Math.min(1, used / window);
		const compactAt = ctx.bundle.compaction.threshold();
		const barWidth = 40;
		const filled = Math.round(ratio * barWidth);
		const compactMark = Math.round((compactAt / window) * barWidth);
		let bar = "";
		for (let i = 0; i < barWidth; i++) {
			if (i < filled) bar += "█";
			else if (i === compactMark) bar += "│";
			else bar += "░";
		}
		const pct = `${(ratio * 100).toFixed(1)}%`;
		const compactPct = `${((compactAt / window) * 100).toFixed(0)}%`;
		ctx.emit(
			`context window:\n  ${bar}\n  ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pct})\n  │ = compaction triggers at ${compactAt.toLocaleString()} (${compactPct})`,
		);
		return { handled: true };
	},
};
