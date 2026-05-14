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
