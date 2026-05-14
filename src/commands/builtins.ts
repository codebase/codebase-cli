import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CredentialsStore } from "../auth/credentials.js";
import { copyToClipboard, extractLastCodeBlock } from "../clipboard/copy.js";
import { NotAuthenticatedError, ProjectClient, ProjectClientError } from "../projects/client.js";
import type { Command } from "./types.js";

const help: Command = {
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

const clear: Command = {
	name: "clear",
	description: "Clear the on-screen chat history. (Agent context is preserved.)",
	mutates: true,
	handler: (_args, ctx) => {
		ctx.clearDisplay();
		return { handled: true };
	},
};

/**
 * Hard reset: drop both the display transcript AND the agent's internal
 * message history, so the next turn starts with zero context. Use after a
 * topic shift, when the model's gotten stuck in a stale plan, or to free
 * up context space without waiting for compaction.
 */
const fresh: Command = {
	name: "new",
	description: "Start a fresh conversation — wipes both display history and agent context.",
	mutates: true,
	handler: (_args, ctx) => {
		ctx.bundle.agent.state.messages = [];
		ctx.clearDisplay();
		ctx.emit("Started a fresh conversation. Prior context is gone for this and the next turn.");
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

const cost: Command = {
	name: "cost",
	description: "Detailed token + cost breakdown for the current session, including cache hit rate.",
	handler: (_args, ctx) => {
		const { state, bundle } = ctx;
		const u = state.usage;
		const turns = state.messages.filter((m) => m.role === "assistant").length;
		const promptTokens = u.input + u.cacheRead;
		const hitRate = promptTokens > 0 ? `${((u.cacheRead / promptTokens) * 100).toFixed(0)}%` : "—";
		const turnAvg = turns > 0 ? u.cost.total / turns : 0;
		const proxyNote = bundle.source === "proxy" ? " (proxied via codebase.foundation)" : "";

		const lines = [
			`Session cost: $${u.cost.total.toFixed(4)}${proxyNote}`,
			"",
			"Tokens:",
			`  Input         ${padNum(u.input, 8)} ($${u.cost.input.toFixed(4)})`,
			`  Output        ${padNum(u.output, 8)} ($${u.cost.output.toFixed(4)})`,
			`  Cache read    ${padNum(u.cacheRead, 8)} ($${u.cost.cacheRead.toFixed(4)})  ${hitRate} hit rate`,
			`  Cache write   ${padNum(u.cacheWrite, 8)} ($${u.cost.cacheWrite.toFixed(4)})`,
			"",
			turns > 0
				? `Turn average: $${turnAvg.toFixed(4)} (${turns} turn${turns === 1 ? "" : "s"})`
				: "No assistant turns yet.",
		];
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

function padNum(n: number, width: number): string {
	return n.toLocaleString().padStart(width, " ");
}

/**
 * Friendly short-name → "<provider>:<modelId>" map. Lets a user type
 * `/model sonnet` instead of `/model anthropic:claude-sonnet-4-5`. The
 * actual provider availability still depends on the user's account /
 * BYOK keys; aliases just shorten the path for the common cases.
 */
const MODEL_ALIASES: Record<string, string> = {
	auto: "auto", // sentinel; resolved to null override in the handler
	sonnet: "anthropic:claude-sonnet-4-5",
	opus: "anthropic:claude-opus-4-1",
	haiku: "anthropic:claude-haiku-4-5",
	"gpt-5": "openai:gpt-5",
	"gpt-4": "openai:gpt-4o",
	"gpt-4o": "openai:gpt-4o",
	llama: "groq:llama-3.3-70b-versatile",
	"llama-3.3": "groq:llama-3.3-70b-versatile",
};

/** Parse `<provider>:<modelId>` or `<modelId>` or an alias into a model spec. */
function parseModelSpec(raw: string): { provider?: string; modelId: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower === "auto" || lower === "default" || lower === "reset") return null; // signal: reset
	const aliased = MODEL_ALIASES[lower];
	const target = aliased && aliased !== "auto" ? aliased : trimmed;
	const colonIdx = target.indexOf(":");
	if (colonIdx === -1) return { modelId: target };
	return { provider: target.slice(0, colonIdx).trim(), modelId: target.slice(colonIdx + 1).trim() };
}

const modelCmd: Command = {
	name: "model",
	description: "Show or switch the active model. `/model <id>` or `/model <provider>:<id>` to switch.",
	handler: async (args, ctx) => {
		const arg = args.trim();
		if (!arg) {
			// No-args opens the inline picker. For BYOK / non-proxy sessions
			// there's no live model list to fetch, so print the static info
			// instead of an empty overlay.
			if (ctx.bundle.source !== "proxy") {
				const m = ctx.state.model;
				ctx.emit(`Current model: ${m.name} (${m.provider}/${m.id})`);
				ctx.emit("BYOK session — switch via CODEBASE_PROVIDER + CODEBASE_MODEL env vars at launch.");
				return { handled: true };
			}
			ctx.openModelPicker();
			return { handled: true };
		}
		if (arg === "--help" || arg === "-h") {
			ctx.emit("Usage:");
			ctx.emit("  /model              show the active model");
			ctx.emit("  /model <id>         switch (e.g. /model claude-sonnet-4-5)");
			ctx.emit("  /model <prov>:<id>  switch with explicit provider (e.g. /model anthropic:claude-sonnet-4-5)");
			ctx.emit("  /model auto         reset to the default (Codebase Auto for proxy users)");
			ctx.emit("  /model sonnet|opus|haiku|gpt-5|llama  aliases for common picks");
			return { handled: true };
		}
		const spec = parseModelSpec(arg);
		await ctx.switchModel(spec);
		return { handled: true };
	},
};

const modelsCmd: Command = {
	name: "models",
	aliases: ["lm"],
	description: "List models available to your account (fetched live from the proxy).",
	handler: async (_args, ctx) => {
		// BYOK users don't go through our proxy — there's no central
		// "available models" endpoint for arbitrary upstreams. Tell them
		// how to switch and bail.
		if (ctx.bundle.source !== "proxy") {
			ctx.emit(`Current: ${ctx.state.model.name} (${ctx.state.model.provider}/${ctx.state.model.id})`);
			ctx.emit("BYOK session — switch by re-launching with CODEBASE_PROVIDER + CODEBASE_MODEL env vars.");
			return { handled: true };
		}
		const baseUrl = (ctx.bundle.model.baseUrl ?? "").replace(/\/+$/, "");
		if (!baseUrl) {
			ctx.emit("(model has no baseUrl — can't query the proxy)");
			return { handled: true };
		}
		try {
			const apiKey = await ctx.bundle.agent.getApiKey?.(ctx.bundle.model.provider);
			if (!apiKey) {
				ctx.emit("(not signed in — run `codebase auth login`)");
				return { handled: true };
			}
			const res = await fetch(`${baseUrl}/models`, {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			});
			if (!res.ok) {
				ctx.emit(`(failed to fetch models: ${res.status} ${res.statusText})`);
				return { handled: true };
			}
			const json = (await res.json()) as { models?: Array<{ id: string; name: string; provider: string }> };
			const models = json.models ?? [];
			if (models.length === 0) {
				ctx.emit("(no models returned)");
				return { handled: true };
			}
			const current = `${ctx.state.model.provider}/${ctx.state.model.id}`;
			ctx.emit("Available models (* = active):");
			// Group by provider so the list reads as a tree.
			const byProvider = new Map<string, Array<{ id: string; name: string }>>();
			for (const m of models) {
				const arr = byProvider.get(m.provider) ?? [];
				arr.push({ id: m.id, name: m.name });
				byProvider.set(m.provider, arr);
			}
			const providers = [...byProvider.keys()].sort();
			for (const p of providers) {
				ctx.emit(`  ${p}:`);
				for (const m of byProvider.get(p) ?? []) {
					const marker = `${p}/${m.id}` === current ? "*" : " ";
					ctx.emit(`    ${marker} ${m.id}  ${m.name === m.id ? "" : `· ${m.name}`}`);
				}
			}
			ctx.emit("Switch: /model <id> · /model <provider>:<id>");
		} catch (err) {
			ctx.emit(`(error fetching models: ${err instanceof Error ? err.message : String(err)})`);
		}
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

// ─── git surface ──────────────────────────────────────────────────────

const diff: Command = {
	name: "diff",
	description: "Show the working-tree diff (`git diff` shortstat then full).",
	handler: (args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		const target = args.trim() || "HEAD";
		try {
			const stat = execSync(`git diff --stat ${target}`, { cwd, encoding: "utf8" }).trim();
			const full = execSync(`git diff ${target}`, { cwd, encoding: "utf8" });
			if (!stat && !full) {
				ctx.emit("no changes vs HEAD.");
				return { handled: true };
			}
			ctx.emit(`${stat}\n\n${full}`);
		} catch (err) {
			ctx.emit(`/diff failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

const commit: Command = {
	name: "commit",
	description: "Generate a commit message for the current diff via the smart glue model. Does not commit.",
	handler: async (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		try {
			const diffText = execSync("git diff --staged", { cwd, encoding: "utf8" });
			if (!diffText.trim()) {
				ctx.emit("nothing staged. Run `git add <files>` first, then /commit.");
				return { handled: true };
			}
			const system =
				"You write Conventional Commits messages. Subject ≤72 chars, imperative mood. " +
				"Body 1–3 short lines explaining WHY, not WHAT. No bullet lists. No file inventory.";
			const message = await ctx.bundle.glue.smart(`Generate a commit message for this diff:\n\n${diffText}`, system);
			ctx.emit(
				`suggested commit message:\n\n${message.trim()}\n\nIf you like it: git commit -m "..." (with the subject above).`,
			);
		} catch (err) {
			ctx.emit(`/commit failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

const review: Command = {
	name: "review",
	description: "Have the smart glue model review your uncommitted changes.",
	handler: async (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		try {
			const diffText = execSync("git diff HEAD", { cwd, encoding: "utf8" });
			if (!diffText.trim()) {
				ctx.emit("no changes to review (working tree matches HEAD).");
				return { handled: true };
			}
			const system =
				"You are a senior engineer doing a code review. Be concise and concrete. " +
				"Call out: bugs, missing edge cases, security issues, naming nits, simpler alternatives. " +
				"Skip praise. If the diff is clean, say so in one line.";
			const text = await ctx.bundle.glue.smart(`Review this diff:\n\n${diffText}`, system);
			ctx.emit(text.trim());
		} catch (err) {
			ctx.emit(`/review failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { handled: true };
	},
};

// ─── memory + context ─────────────────────────────────────────────────

const memory: Command = {
	name: "memory",
	description: "Show the MEMORY.md index of saved cross-session memories for this project.",
	handler: (_args, ctx) => {
		const index = ctx.bundle.memory.index();
		if (!index.trim()) {
			ctx.emit("no memories saved yet. The agent can write them via the save_memory tool.");
			return { handled: true };
		}
		ctx.emit(index);
		return { handled: true };
	},
};

const context: Command = {
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

/**
 * Diagnostic for "the model isn't remembering what I told it earlier."
 * Compares the UI's display state (what the user sees in the transcript)
 * with the agent's internal _state.messages (what actually ships to the
 * model on the next turn). If those diverge, that's the bug. If they
 * match but the model still acts amnesiac, the issue is in the wire
 * call — pi-ai's openai-completions builder, the proxy, or the upstream.
 */
const debug: Command = {
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

// ─── auth / session ───────────────────────────────────────────────────

const login: Command = {
	name: "login",
	description: "Sign in via codebase.design OAuth (run from a fresh terminal: `codebase auth login`).",
	handler: (_args, ctx) => {
		ctx.emit(
			"to sign in, exit (Ctrl-C) and run:\n  codebase auth login\n\n" +
				"that opens your browser to codebase.design and persists tokens to ~/.codebase/credentials.json. " +
				"after sign-in, restart codebase to use the new credentials.",
		);
		return { handled: true };
	},
};

const logout: Command = {
	name: "logout",
	description: "Clear saved credentials. Restart to take effect.",
	mutates: true,
	handler: (_args, ctx) => {
		const store = new CredentialsStore();
		const cleared = store.clear();
		if (cleared) {
			ctx.emit("cleared ~/.codebase/credentials.json. Restart codebase to use a different provider/sign-in.");
		} else {
			ctx.emit("no saved credentials to clear.");
		}
		return { handled: true };
	},
};

const resume: Command = {
	name: "resume",
	description: "Resume a previous session (run with the --resume flag at startup).",
	handler: (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		ctx.emit(
			"to resume, exit (Ctrl-C) and start with:\n  codebase --resume\n\n" +
				`session files live at ~/.codebase/sessions/ keyed off this directory (${cwd}).`,
		);
		return { handled: true };
	},
};

// ─── project + extensions ─────────────────────────────────────────────

const init: Command = {
	name: "init",
	description: "Drop a starter CLAUDE.md at the project root with instructions for the agent.",
	mutates: true,
	handler: (_args, ctx) => {
		const cwd = ctx.bundle.toolContext.cwd;
		const target = join(cwd, "CLAUDE.md");
		if (existsSync(target)) {
			ctx.emit(`CLAUDE.md already exists at ${target}. Edit it directly; it's auto-injected on session start.`);
			return { handled: true };
		}
		const template = [
			"# Project Instructions",
			"",
			"This file is auto-loaded by `codebase` on session start.",
			"Use it to capture project-specific rules and context the agent should follow.",
			"",
			"## What this project is",
			"",
			"Replace this with a one-paragraph summary of what the codebase does, the",
			"primary language(s), and the user-visible product.",
			"",
			"## Commands",
			"",
			"- Build:  `…`",
			"- Test:   `…`",
			"- Lint:   `…`",
			"",
			"## Coding conventions",
			"",
			"- …",
			"",
			"## Don'ts",
			"",
			"- …",
			"",
		].join("\n");
		writeFileSync(target, template);
		ctx.emit(`wrote ${target}. Edit it to capture project-specific guidance for the agent.`);
		return { handled: true };
	},
};

const projects: Command = {
	name: "projects",
	aliases: ["project"],
	description: "List your projects from codebase.design (requires sign-in via `codebase auth login`).",
	handler: async (_args, ctx) => {
		const client = new ProjectClient();
		if (!client.hasCredentials()) {
			ctx.emit(
				"not signed in. Run `codebase auth login` from a fresh terminal, then come back. " +
					"Env-var providers (ANTHROPIC_API_KEY etc.) work fine for inference but the projects " +
					"endpoint is gated on a codebase.design account.",
			);
			return { handled: true };
		}
		try {
			const list = await client.list();
			if (list.length === 0) {
				ctx.emit("(no projects yet — build one at https://codebase.design)");
				return { handled: true };
			}
			const lines = [`${list.length} project${list.length === 1 ? "" : "s"} on your account:`, ""];
			for (const p of list) {
				const tag = p.source === "storage-only" ? " [storage]" : "";
				const date = p.publishedAt ? ` · ${p.publishedAt.slice(0, 10)}` : "";
				lines.push(`  ${p.id}  ${p.title ?? "(untitled)"}${tag}${date}`);
			}
			lines.push("");
			lines.push("pull one with:  codebase project pull <id>");
			ctx.emit(lines.join("\n"));
		} catch (err) {
			if (err instanceof NotAuthenticatedError) {
				ctx.emit(err.message);
			} else if (err instanceof ProjectClientError) {
				ctx.emit(`/projects failed: ${err.message}`);
			} else {
				ctx.emit(`/projects failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return { handled: true };
	},
};

const mcp: Command = {
	name: "mcp",
	description: "Manage MCP (Model Context Protocol) servers — placeholder until Phase 9 lands.",
	handler: (_args, ctx) => {
		const configPath = join(homedir(), ".codebase", "config.json");
		ctx.emit(
			"MCP support is on the Phase 9 roadmap; the runtime hasn't shipped it yet.\n" +
				`When it lands, server config will live at ${configPath} under "mcp_servers".`,
		);
		return { handled: true };
	},
};

const redo: Command = {
	name: "redo",
	aliases: ["retry"],
	description: "Resend the last user prompt to the agent (e.g. after an error or aborted turn).",
	handler: (_args, ctx) => {
		const lastUser = [...ctx.state.messages].reverse().find((m) => m.role === "user");
		if (!lastUser) {
			ctx.emit("nothing to redo — no prior user prompts.");
			return { handled: true };
		}
		const text = typeof lastUser.content === "string" ? lastUser.content : "";
		if (!text) {
			ctx.emit("can't redo — the last user message had non-text content.");
			return { handled: true };
		}
		ctx.emit(`(redo) ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
		// Route through the bundle helper so UserPromptSubmit hooks fire on
		// /redo too — a hook that rejects secrets shouldn't be bypassed just
		// because the same prompt is being re-issued.
		void ctx.bundle.submitUserPrompt(text).then((result) => {
			if (!result.submitted && result.reason) ctx.emit(`Prompt blocked by hook: ${result.reason}`);
		});
		return { handled: true };
	},
};

const pwd: Command = {
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

export const BUILTIN_COMMANDS: readonly Command[] = [
	help,
	clear,
	fresh,
	compact,
	session,
	cost,
	modelCmd,
	modelsCmd,
	whoami,
	copy,
	diff,
	commit,
	review,
	memory,
	context,
	login,
	logout,
	resume,
	init,
	projects,
	mcp,
	pwd,
	redo,
	debug,
	exit,
];
