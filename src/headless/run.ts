import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type AgentBundle, type CreateAgentOptions, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type HeadlessOutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
	prompt: string;
	resume?: boolean;
	/** Output shape. Default `text`. */
	outputFormat?: HeadlessOutputFormat;
	/**
	 * Auto-approve every permission prompt. Required for any non-
	 * interactive use — without it the agent hangs forever the first
	 * time a write tool fires, since there's no TUI to answer.
	 */
	autoApprove?: boolean;
	stdout?: (chunk: string) => void;
	stderr?: (chunk: string) => void;
	/**
	 * Test escape hatch — passed straight through to createAgent so unit
	 * tests can inject a pi-ai faux provider instead of requiring real
	 * env-var keys. Production code never sets this.
	 */
	configOverride?: CreateAgentOptions["configOverride"];
}

/**
 * Run a single prompt without the TUI:
 *
 *   • text          (default) — assistant text to stdout, tool
 *                    activity to stderr, plain text. Pipe-friendly:
 *                    `codebase run "…" > out.md`.
 *   • stream-json   — every AgentEvent as a JSONL line on stdout, in
 *                    real time. Suitable for an upstream consumer
 *                    (CI, IDE integration) that wants progress events.
 *   • json          — buffer everything; on completion emit ONE JSON
 *                    object with the final transcript + usage + exit
 *                    metadata. Suitable for one-shot CI calls that
 *                    just want the final answer + cost.
 *
 * In stream-json/json modes errors land in stdout as a structured
 * event with `type: "error"` so consumers don't have to merge
 * stdout+stderr. Setup errors (e.g. ConfigError before the loop
 * starts) still go to stderr because they predate the JSON
 * envelope.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
	const out = opts.stdout ?? ((c) => process.stdout.write(c));
	const err = opts.stderr ?? ((c) => process.stderr.write(c));
	const format: HeadlessOutputFormat = opts.outputFormat ?? "text";

	let bundle: AgentBundle;
	try {
		bundle = createAgent({
			resume: opts.resume,
			autoApprove: opts.autoApprove,
			configOverride: opts.configOverride,
		});
	} catch (e) {
		const msg = e instanceof ConfigError ? e.message : e instanceof Error ? e.message : String(e);
		err(`error: ${msg}\n`);
		return 1;
	}

	const startedAt = Date.now();
	let aborted = false;
	let errored = false;
	let errorMessage: string | undefined;
	let totalUsage: Usage = { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } };

	// Always tap the event stream for usage accumulation, regardless of
	// output format — pi-agent-core surfaces per-turn usage on
	// message_end events; the JSON output reports the running total.
	const usageUnsub = bundle.subscribe((event: AgentEvent) => {
		if (event.type !== "message_end") return;
		const candidate = (event.message as { usage?: Usage }).usage;
		if (candidate) totalUsage = mergeUsage(totalUsage, candidate);
	});

	const onSigInt = () => {
		aborted = true;
		bundle.agent.abort();
	};
	process.on("SIGINT", onSigInt);

	let unsubscribe: () => void;
	if (format === "stream-json") {
		unsubscribe = subscribeStreamJson(bundle, out);
	} else if (format === "json") {
		unsubscribe = () => {
			// JSON mode buffers via the agent's own state.messages; the
			// subscribe handler is a no-op so we don't spam stderr.
		};
	} else {
		unsubscribe = subscribeText(bundle, out, err);
	}

	try {
		// Route through the bundle helper so UserPromptSubmit hooks fire on
		// headless runs too (CI scripts, scheduled jobs). A hook veto exits
		// with code 1 and the reason printed to stderr.
		const submitResult = await bundle.submitUserPrompt(opts.prompt);
		if (!submitResult.submitted) {
			errored = true;
			errorMessage = submitResult.reason ?? "Prompt blocked by hook.";
			err(`prompt blocked: ${errorMessage}\n`);
		}
	} catch (e) {
		errored = true;
		errorMessage = e instanceof Error ? e.message : String(e);
		if (format === "stream-json") {
			out(`${JSON.stringify({ type: "error", error: errorMessage, ts: Date.now() })}\n`);
		} else if (format !== "json") {
			err(`agent error: ${errorMessage}\n`);
		}
	} finally {
		unsubscribe();
		usageUnsub();
		process.off("SIGINT", onSigInt);
	}

	const exitCode = aborted ? 130 : errored ? 1 : 0;

	if (format === "json") {
		const payload = buildJsonResult({
			ok: !errored && !aborted,
			exitCode,
			error: errorMessage,
			messages: bundle.agent.state.messages,
			usage: totalUsage,
			model: { provider: bundle.model.provider, id: bundle.model.id, name: bundle.model.name },
			source: bundle.source,
			durationMs: Date.now() - startedAt,
		});
		out(`${JSON.stringify(payload)}\n`);
	}

	return exitCode;
}

function mergeUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

interface JsonResultInput {
	ok: boolean;
	exitCode: number;
	error?: string;
	messages: AgentMessage[];
	usage: unknown;
	model: { provider: string; id: string; name: string };
	source: string;
	durationMs: number;
}

/** Exported for unit tests — production code reaches it through runHeadless. */
export function buildJsonResult(input: JsonResultInput): Record<string, unknown> {
	const lastAssistant = [...input.messages].reverse().find((m) => m.role === "assistant");
	return {
		ok: input.ok,
		exitCode: input.exitCode,
		...(input.error ? { error: input.error } : {}),
		model: input.model,
		source: input.source,
		durationMs: input.durationMs,
		usage: input.usage,
		messageCount: input.messages.length,
		finalText: lastAssistant ? extractText(lastAssistant) : "",
		messages: input.messages,
	};
}

function subscribeStreamJson(bundle: AgentBundle, out: (s: string) => void): () => void {
	return bundle.subscribe((event: AgentEvent) => {
		// One AgentEvent per line. Inject a timestamp so consumers can
		// reason about latency without re-deriving from clock skew.
		out(`${JSON.stringify({ ...event, ts: Date.now() })}\n`);
	});
}

function subscribeText(bundle: AgentBundle, out: (s: string) => void, err: (s: string) => void): () => void {
	let lastStreamLen = 0;
	return bundle.subscribe((event: AgentEvent) => {
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
