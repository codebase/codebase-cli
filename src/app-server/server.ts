import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type AgentBundle, type CreateAgentOptions, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import type { PermissionRequest } from "../permissions/store.js";
import {
	buildErrorResponse,
	isCommand,
	type ModelInfo,
	type OutboundMessage,
	type PendingPermission,
	type RpcCommand,
	type RpcResponse,
	type SessionState,
} from "./protocol.js";

const USER_AGENT = "codebase-cli/app-server";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface AppServerOptions {
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
	/** When true, attempt to resume the previous session for this cwd. */
	resume?: boolean;
	/** When true, every tool call that would prompt the user auto-allows. */
	autoApprove?: boolean;
	/**
	 * Test escape hatch — forwarded straight to createAgent so tests
	 * can inject a pi-ai faux provider. Production never sets this.
	 */
	configOverride?: CreateAgentOptions["configOverride"];
}

/**
 * Start the JSON-RPC server on stdio.
 *
 * One connection = one agent instance = one session. The function
 * resolves when stdin is closed; the caller (cli.tsx) exits with the
 * returned exit code.
 */
export async function runAppServer(opts: AppServerOptions = {}): Promise<number> {
	const stdin = opts.stdin ?? process.stdin;
	const stdout = opts.stdout ?? process.stdout;
	const stderr = opts.stderr ?? process.stderr;

	function send(message: OutboundMessage): void {
		stdout.write(`${JSON.stringify(message)}\n`);
	}

	function fatal(error: string): number {
		send({ type: "event", event: { type: "server_error", message: error } });
		return 1;
	}

	let bundle: AgentBundle;
	try {
		bundle = createAgent({
			resume: opts.resume,
			autoApprove: opts.autoApprove,
			configOverride: opts.configOverride,
		});
	} catch (e) {
		const msg = e instanceof ConfigError ? e.message : e instanceof Error ? e.message : String(e);
		stderr.write(`app-server: ${msg}\n`);
		return fatal(msg);
	}

	let totalUsage: Usage = { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } };
	let status: SessionState["status"] = "idle";
	let pendingPermission: PendingPermission | undefined;
	let inFlightPrompt: Promise<void> | null = null;

	// ─── outbound: forward agent events + track status ──────────────────

	const unsubscribeAgent = bundle.subscribe((event: AgentEvent) => {
		// Update local status mirror for get_state queries.
		if (event.type === "agent_start" || event.type === "turn_start") {
			status = "thinking";
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			status = "streaming";
		} else if (event.type === "tool_execution_start") {
			status = "tool";
		} else if (event.type === "tool_execution_end") {
			status = "thinking";
		} else if (event.type === "agent_end") {
			status = "idle";
		}

		// Accumulate usage from message_end events (pi-agent-core
		// emits per-message usage there).
		if (event.type === "message_end") {
			const candidate = (event.message as { usage?: Usage }).usage;
			if (candidate) {
				totalUsage = mergeUsage(totalUsage, candidate);
				send({ type: "event", event: { type: "usage_update", usage: totalUsage } });
			}
		}

		send({ type: "event", event });
	});

	// ─── permission requests: forward to the extension ─────────────────

	const unsubscribePerms = bundle.permissions.subscribe((req: PermissionRequest | undefined) => {
		if (!req) {
			if (pendingPermission) {
				pendingPermission = undefined;
				send({ type: "event", event: { type: "permission_cleared" } });
			}
			status = inFlightPrompt ? "thinking" : "idle";
			return;
		}
		pendingPermission = {
			id: req.id,
			tool: req.tool,
			summary: req.summary,
			detail: req.detail,
			risk: req.risk,
		};
		status = "awaiting-permission";
		send({
			type: "event",
			event: { type: "permission_request", request: pendingPermission },
		});
	});

	// ─── inbound: line-by-line JSONL on stdin ───────────────────────────

	const reader = createInterface({ input: stdin, crlfDelay: Infinity });

	send({ type: "event", event: { type: "server_ready" } });

	let initialized = false;

	for await (const line of reader) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let command: unknown;
		try {
			command = JSON.parse(trimmed);
		} catch (e) {
			send(
				buildErrorResponse(undefined, "parse", `JSON parse error: ${e instanceof Error ? e.message : String(e)}`),
			);
			continue;
		}

		if (!isCommand(command)) {
			send(buildErrorResponse(undefined, "parse", "command must be an object with a `type` field"));
			continue;
		}

		const c = command as RpcCommand;

		// Gate everything except initialize until we're initialized.
		if (!initialized && c.type !== "initialize") {
			send(buildErrorResponse(c.id, c.type, "send `initialize` first"));
			continue;
		}

		try {
			const response = await dispatch(c);
			if (response) send(response);
		} catch (e) {
			send(buildErrorResponse(c.id, c.type, e instanceof Error ? e.message : String(e)));
		}
	}

	unsubscribeAgent();
	unsubscribePerms();
	return 0;

	// ─── command dispatch ──────────────────────────────────────────────

	async function dispatch(c: RpcCommand): Promise<RpcResponse | null> {
		switch (c.type) {
			case "initialize": {
				initialized = true;
				const model = modelInfo();
				return {
					id: c.id,
					type: "response",
					command: "initialize",
					success: true,
					data: { userAgent: USER_AGENT, model, source: bundle.source },
				};
			}

			case "prompt": {
				if (inFlightPrompt) {
					return buildErrorResponse(c.id, c.type, "a prompt is already in flight — abort first");
				}
				// Fire-and-forget; the response just acknowledges receipt.
				// The real work surfaces via the agent event stream. Pi's
				// `prompt(text, images?)` overload handles multimodal input
				// transparently — base64-encoded image bytes plus mimeType.
				const images = c.images && c.images.length > 0 ? [...c.images] : undefined;
				inFlightPrompt = bundle.agent
					.prompt(c.message, images)
					.catch((err: unknown) => {
						send(buildErrorResponse(undefined, "prompt", err instanceof Error ? err.message : String(err)));
					})
					.finally(() => {
						inFlightPrompt = null;
					});
				return { id: c.id, type: "response", command: "prompt", success: true };
			}

			case "abort": {
				bundle.agent.abort();
				return { id: c.id, type: "response", command: "abort", success: true };
			}

			case "get_state": {
				return {
					id: c.id,
					type: "response",
					command: "get_state",
					success: true,
					data: buildState(),
				};
			}

			case "get_messages": {
				return {
					id: c.id,
					type: "response",
					command: "get_messages",
					success: true,
					data: { messages: bundle.agent.state.messages },
				};
			}

			case "set_model": {
				// Light-touch: pi-agent-core's Agent exposes a `state.model`
				// setter, but switching mid-session requires careful handling
				// of in-flight requests. For now we reject — the user picks
				// the model at startup via env vars and we just report it.
				return buildErrorResponse(
					c.id,
					c.type,
					"set_model is not yet supported in app-server mode — set CODEBASE_PROVIDER + CODEBASE_MODEL before launch",
				);
			}

			case "permission_respond": {
				if (!pendingPermission || pendingPermission.id !== c.requestId) {
					return buildErrorResponse(c.id, c.type, "no matching pending permission request");
				}
				bundle.permissions.respond(c.requestId, c.choice);
				return { id: c.id, type: "response", command: "permission_respond", success: true };
			}
		}
	}

	function modelInfo(): ModelInfo {
		return {
			provider: bundle.model.provider,
			id: bundle.model.id,
			name: bundle.model.name,
		};
	}

	function buildState(): SessionState {
		return {
			model: modelInfo(),
			source: bundle.source,
			status,
			messageCount: bundle.agent.state.messages.length,
			usage: totalUsage,
			cwd: bundle.toolContext.cwd,
			pendingPermission,
		};
	}
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
