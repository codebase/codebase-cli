import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";

/**
 * Wire shape for `codebase app-server`. Newline-delimited JSON on
 * stdin/stdout. Modeled on pi-coding-agent's RPC envelope so a
 * future shared extension can speak both. Not strict JSON-RPC 2.0 —
 * the simpler `{ id?, type }` envelope reads better in logs and
 * matches the upstream convention.
 *
 * Lifecycle:
 *   1. client → `initialize` with clientInfo
 *   2. server → response { ok, userAgent, model }
 *   3. client → `prompt`, `abort`, `get_state`, etc.
 *   4. server → response (per inbound) + event stream (notifications)
 *
 * One connection = one agent = one session. Closing stdin shuts the
 * server down. Re-running with `--resume` restores the previous
 * session's transcript on launch.
 */

// ─── inbound (client → server) ────────────────────────────────────────

export type RpcCommand =
	| { id?: string; type: "initialize"; clientInfo: ClientInfo }
	| { id?: string; type: "prompt"; message: string; images?: readonly ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| {
			id?: string;
			type: "permission_respond";
			requestId: string;
			choice: "allow-once" | "trust-tool" | "trust-all" | "deny";
	  };

export interface ClientInfo {
	name: string;
	version: string;
	title?: string;
}

// ─── outbound: responses (server → client) ────────────────────────────

export type RpcResponse =
	| {
			id?: string;
			type: "response";
			command: "initialize";
			success: true;
			data: { userAgent: string; model: ModelInfo; source: string };
	  }
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_state";
			success: true;
			data: SessionState;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_messages";
			success: true;
			data: { messages: AgentMessage[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: ModelInfo;
	  }
	| { id?: string; type: "response"; command: "permission_respond"; success: true }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export interface SessionState {
	model: ModelInfo;
	source: string;
	status: "idle" | "thinking" | "streaming" | "tool" | "awaiting-permission";
	messageCount: number;
	usage: Usage;
	cwd: string;
	pendingPermission?: PendingPermission;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
}

export interface PendingPermission {
	id: string;
	tool: string;
	summary: string;
	detail?: string;
	risk: "low" | "medium" | "high";
}

// ─── outbound: events (server → client, unsolicited) ──────────────────

/**
 * The agent loop emits AgentEvents on every step (message_start,
 * message_update, tool_execution_start, tool_execution_end,
 * agent_end, …). The app-server forwards each event verbatim
 * wrapped in an `RpcEvent` envelope, so the extension sees the
 * same stream the TUI does. Plus a few app-server-specific events
 * for things the AgentEvent stream doesn't cover (permission
 * requests, usage deltas, etc.).
 */
export type RpcEvent =
	| { type: "event"; event: AgentEvent }
	| { type: "event"; event: { type: "permission_request"; request: PendingPermission } }
	| { type: "event"; event: { type: "permission_cleared" } }
	| { type: "event"; event: { type: "usage_update"; usage: Usage } }
	| { type: "event"; event: { type: "server_ready" } }
	| { type: "event"; event: { type: "server_error"; message: string } };

export type OutboundMessage = RpcResponse | RpcEvent;

export function isCommand(value: unknown): value is RpcCommand {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function buildErrorResponse(id: string | undefined, command: string, error: string): RpcResponse {
	return { id, type: "response", command, success: false, error };
}

// Re-exports so the extension can type-check against this without
// pulling in pi-agent-core directly.
export type { AgentEvent, AgentMessage, Model, Usage };
