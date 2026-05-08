import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";

export interface HeadlessOptions {
	prompt: string;
	resume?: boolean;
	stdout?: (chunk: string) => void;
	stderr?: (chunk: string) => void;
}

/**
 * Run a single prompt without the TUI: stream assistant text to stdout,
 * tool activity to stderr (for diagnostic visibility without polluting
 * piped output), exit on agent_end. Designed for CI / scripting use:
 * `codebase run "summarize this repo" > out.md`.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
	const out = opts.stdout ?? ((c) => process.stdout.write(c));
	const err = opts.stderr ?? ((c) => process.stderr.write(c));

	let bundle: AgentBundle;
	try {
		bundle = createAgent({ resume: opts.resume });
	} catch (e) {
		const msg = e instanceof ConfigError ? e.message : e instanceof Error ? e.message : String(e);
		err(`error: ${msg}\n`);
		return 1;
	}

	let lastStreamLen = 0;
	let aborted = false;
	let errored = false;

	const onSigInt = () => {
		aborted = true;
		bundle.agent.abort();
	};
	process.on("SIGINT", onSigInt);

	const unsubscribe = bundle.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "tool_execution_start":
				err(`[${event.toolName}…]\n`);
				return;
			case "tool_execution_end":
				if (event.isError) err(`[${event.toolName} ERROR]\n`);
				return;
			case "message_update": {
				if (event.message.role !== "assistant") return;
				const text = extractText(event.message);
				if (text.length > lastStreamLen) {
					out(text.slice(lastStreamLen));
					lastStreamLen = text.length;
				}
				return;
			}
			case "message_end": {
				if (event.message.role !== "assistant") return;
				const text = extractText(event.message);
				if (text.length > lastStreamLen) out(text.slice(lastStreamLen));
				lastStreamLen = 0;
				out("\n");
				return;
			}
			case "agent_end":
				return;
		}
	});

	try {
		await bundle.agent.prompt(opts.prompt);
	} catch (e) {
		errored = true;
		err(`agent error: ${e instanceof Error ? e.message : String(e)}\n`);
	} finally {
		unsubscribe();
		process.off("SIGINT", onSigInt);
	}

	if (aborted) return 130;
	return errored ? 1 : 0;
}

function extractText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content as Array<{ type: string; text?: string }>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}
