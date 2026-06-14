import type { Command } from "../types.js";

export const clear: Command = {
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
export const fresh: Command = {
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

export const compact: Command = {
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

export const session: Command = {
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

export const resume: Command = {
	name: "resume",
	aliases: ["sessions"],
	description: "List saved sessions for this project; /resume <n> swaps to one in place.",
	handler: async (args, ctx) => {
		const summaries = ctx.bundle.sessions.list();
		const currentId = ctx.bundle.sessions.id;

		if (!args.trim()) {
			if (summaries.length === 0) {
				ctx.emit("No saved sessions for this directory yet — they're written after every agent turn.");
				return { handled: true };
			}
			ctx.emit("Saved sessions (newest first):");
			summaries.forEach((s, i) => {
				const marker = s.id === currentId ? "▸" : " ";
				const title = s.title ?? "(untitled)";
				const age = formatAge(Date.now() - s.updatedAt);
				const tags = s.tags.length ? ` [${s.tags.join(", ")}]` : "";
				ctx.emit(`${marker} ${i + 1}. ${title}${tags} — ${age} · ${s.messageCount} messages · ${s.modelId}`);
			});
			ctx.emit("Run /resume <n> to swap the conversation in place (current session stays saved).");
			return { handled: true };
		}

		const n = Number.parseInt(args.trim(), 10);
		const picked = Number.isInteger(n) ? summaries[n - 1] : summaries.find((s) => s.id === args.trim());
		if (!picked) {
			ctx.emit(`No session "${args.trim()}". Run /resume to list them.`);
			return { handled: true };
		}
		if (picked.id === currentId) {
			ctx.emit("That's the current session.");
			return { handled: true };
		}
		await ctx.switchSession(picked.id);
		return { handled: true };
	},
};

export const rename: Command = {
	name: "rename",
	description: "Set a title for the current session (replaces the auto-derived one).",
	handler: (args, ctx) => {
		const title = args.trim();
		if (!title) {
			const current = ctx.bundle.sessions.list().find((s) => s.id === ctx.bundle.sessions.id);
			ctx.emit(
				current?.title
					? `Current title: ${current.title}. Run /rename <new title> to change it.`
					: "Usage: /rename <title>",
			);
			return { handled: true };
		}
		ctx.bundle.sessions.rename(title);
		ctx.emit(`Session renamed to "${title}".`);
		return { handled: true };
	},
};

export const tag: Command = {
	name: "tag",
	description: "Tag the current session (space/comma-separated); /tag with no args lists tags.",
	handler: (args, ctx) => {
		const current = ctx.bundle.sessions.list().find((s) => s.id === ctx.bundle.sessions.id);
		if (!args.trim()) {
			const tags = current?.tags ?? [];
			ctx.emit(tags.length ? `Tags: ${tags.join(", ")}` : "No tags yet. Run /tag <tag …> to add some.");
			return { handled: true };
		}
		// `+foo` / `-foo` add/remove against the existing set; a bare list replaces it.
		const tokens = args
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter(Boolean);
		const incremental = tokens.some((t) => t.startsWith("+") || t.startsWith("-"));
		let next: string[];
		if (incremental) {
			next = [...(current?.tags ?? [])];
			for (const t of tokens) {
				if (t.startsWith("-")) {
					const name = t.slice(1);
					next = next.filter((x) => x !== name);
				} else {
					const name = t.startsWith("+") ? t.slice(1) : t;
					if (name && !next.includes(name)) next.push(name);
				}
			}
		} else {
			next = [...new Set(tokens)];
		}
		ctx.bundle.sessions.setTags(next);
		ctx.emit(next.length ? `Tags: ${next.join(", ")}` : "Tags cleared.");
		return { handled: true };
	},
};

function formatAge(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export const redo: Command = {
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

export const exit: Command = {
	name: "exit",
	aliases: ["quit"],
	description: "Quit codebase.",
	handler: (_args, ctx) => {
		ctx.exit();
		return { handled: true };
	},
};
