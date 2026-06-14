import { CLIENT_INFO, type McpClient, REQUEST_TIMEOUT_MS } from "./client.js";
import type { McpAuthProvider } from "./oauth/provider.js";
import {
	isResponse,
	type JsonRpcResponse,
	MCP_PROTOCOL_VERSION,
	type McpCallToolResult,
	type McpGetPromptResult,
	type McpPromptDescriptor,
	type McpReadResourceResult,
	type McpResourceDescriptor,
	type McpToolDescriptor,
	parseRpcLine,
} from "./protocol.js";

export interface HttpServerSpec {
	/** Endpoint URL of the remote MCP server. */
	url: string;
	/** Static headers sent on every request — e.g. `{ Authorization: "Bearer …" }`. */
	headers?: Record<string, string>;
}

/**
 * MCP client over the Streamable HTTP transport (spec rev 2025-03-26+):
 * one endpoint, JSON-RPC over POST. The server answers each POST with
 * either a single `application/json` body or a `text/event-stream` that
 * carries our response (plus any server notifications, which we skip).
 *
 * Session continuity uses the `Mcp-Session-Id` header the server hands
 * back on initialize; we echo it on every later request and DELETE it on
 * close. The negotiated protocol version rides the `MCP-Protocol-Version`
 * header after the handshake.
 *
 * Server → client requests (sampling, elicitation) are not supported; we
 * ignore inbound messages that aren't responses to our own requests.
 *
 * An optional auth provider supplies bearer credentials and reacts to a
 * 401 by (re)authorizing; the request is then retried once.
 */
export class HttpMcpClient implements McpClient {
	private nextId = 1;
	private sessionId: string | undefined;
	private negotiatedVersion = MCP_PROTOCOL_VERSION;
	private closed = false;

	constructor(
		readonly name: string,
		private readonly spec: HttpServerSpec,
		private readonly auth?: McpAuthProvider,
	) {}

	async connect(): Promise<void> {
		const res = await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		const result = res.result as { protocolVersion?: string } | undefined;
		if (typeof result?.protocolVersion === "string") this.negotiatedVersion = result.protocolVersion;
		await this.notify("notifications/initialized");
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		const res = await this.request("tools/list", {});
		const result = res.result as { tools?: McpToolDescriptor[] } | undefined;
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	async callTool(name: string, args: unknown): Promise<McpCallToolResult> {
		const res = await this.request("tools/call", { name, arguments: args ?? {} });
		return (res.result as McpCallToolResult) ?? {};
	}

	async listResources(): Promise<McpResourceDescriptor[]> {
		try {
			const res = await this.request("resources/list", {});
			const result = res.result as { resources?: McpResourceDescriptor[] } | undefined;
			return Array.isArray(result?.resources) ? result.resources : [];
		} catch {
			return [];
		}
	}

	async readResource(uri: string): Promise<McpReadResourceResult> {
		const res = await this.request("resources/read", { uri });
		return (res.result as McpReadResourceResult) ?? {};
	}

	async listPrompts(): Promise<McpPromptDescriptor[]> {
		try {
			const res = await this.request("prompts/list", {});
			const result = res.result as { prompts?: McpPromptDescriptor[] } | undefined;
			return Array.isArray(result?.prompts) ? result.prompts : [];
		} catch {
			return [];
		}
	}

	async getPrompt(name: string, args: Record<string, string>): Promise<McpGetPromptResult> {
		const res = await this.request("prompts/get", { name, arguments: args });
		return (res.result as McpGetPromptResult) ?? {};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// Best-effort session teardown; the server frees its state on DELETE.
		if (this.sessionId) {
			void fetch(this.spec.url, { method: "DELETE", headers: this.baseHeaders() }).catch(() => undefined);
		}
	}

	/** Transport headers, sans auth (auth is async — see buildHeaders). */
	private baseHeaders(): Record<string, string> {
		const h: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.spec.headers,
		};
		// Per spec the protocol-version header is sent on every request
		// after the handshake; harmless to include during it too.
		h["MCP-Protocol-Version"] = this.negotiatedVersion;
		if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
		return h;
	}

	/** Full request headers including any bearer credentials from the auth provider. */
	private async buildHeaders(): Promise<Record<string, string>> {
		const h = this.baseHeaders();
		if (this.auth) Object.assign(h, await this.auth.authHeaders());
		return h;
	}

	private async request(method: string, params: unknown): Promise<JsonRpcResponse> {
		if (this.closed) throw new Error(`MCP server "${this.name}" is not connected`);
		const id = this.nextId++;
		const res = await this.post({ jsonrpc: "2.0", id, method, params }, method);

		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			return await this.readSseResponse(res, id, method);
		}
		const body = (await res.json()) as JsonRpcResponse;
		return this.unwrap(body, method);
	}

	private async notify(method: string, params?: unknown): Promise<void> {
		if (this.closed) return;
		// Notifications get a 202 with no body; we don't read a response.
		const res = await this.post({ jsonrpc: "2.0", method, params }, method);
		// Drain so the socket can be reused / freed.
		await res.body?.cancel().catch(() => undefined);
	}

	private async post(payload: unknown, method: string, isRetry = false): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(this.spec.url, {
				method: "POST",
				headers: await this.buildHeaders(),
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} catch (err) {
			clearTimeout(timer);
			if (controller.signal.aborted) {
				throw new Error(`MCP server "${this.name}" timed out on ${method} after ${REQUEST_TIMEOUT_MS}ms`);
			}
			throw new Error(`MCP server "${this.name}" request to ${this.spec.url} failed: ${(err as Error).message}`);
		}
		clearTimeout(timer);

		// 401 → let the auth provider refresh or run the OAuth flow, then
		// retry exactly once so a single expired token can't loop forever.
		if (res.status === 401 && this.auth && !isRetry) {
			const www = res.headers.get("www-authenticate");
			await res.body?.cancel().catch(() => undefined);
			if (await this.auth.handleUnauthorized(www)) {
				return this.post(payload, method, true);
			}
		}

		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`MCP server "${this.name}" returned HTTP ${res.status} on ${method}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
			);
		}
		return res;
	}

	/** Read an SSE body until the JSON-RPC response matching `id` arrives. */
	private async readSseResponse(res: Response, id: number, method: string): Promise<JsonRpcResponse> {
		if (!res.body) throw new Error(`MCP server "${this.name}" sent an empty SSE body on ${method}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE events are separated by a blank line.
				let sep = buffer.indexOf("\n\n");
				while (sep !== -1) {
					const event = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const msg = parseSseData(event);
					if (msg && isResponse(msg) && msg.id === id) {
						return this.unwrap(msg, method);
					}
					sep = buffer.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		throw new Error(`MCP server "${this.name}" closed the SSE stream before answering ${method}`);
	}

	private unwrap(msg: JsonRpcResponse, method: string): JsonRpcResponse {
		if (msg.error) {
			throw new Error(`MCP server "${this.name}" error on ${method}: ${msg.error.message}`);
		}
		return msg;
	}
}

/** Extract and parse the `data:` payload(s) of one SSE event into a JSON-RPC message. */
function parseSseData(event: string): JsonRpcResponse | null {
	const data = event
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	if (!data) return null;
	const msg = parseRpcLine(data);
	return msg && isResponse(msg) ? msg : null;
}
