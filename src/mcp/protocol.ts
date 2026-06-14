/**
 * Minimal MCP (Model Context Protocol) wire types for the stdio client.
 *
 * MCP over stdio is JSON-RPC 2.0, newline-delimited (one compact JSON
 * object per line, UTF-8). We implement only the client → server calls
 * a tool-consuming agent needs: initialize, tools/list, tools/call.
 * Server → client requests (sampling, elicitation) are not supported in
 * v1; we ignore inbound requests that aren't responses to ours.
 */

/** Protocol version we advertise. Servers may negotiate down; we accept theirs. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** A tool as described by a server's tools/list response. */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments. Passed to the model verbatim. */
	inputSchema?: Record<string, unknown>;
}

/** A content block in a tools/call result. We render text + image; other kinds become text. */
export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content?: McpContentBlock[];
	isError?: boolean;
	[key: string]: unknown;
}

/** A resource as described by a server's resources/list response. */
export interface McpResourceDescriptor {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

/** One content chunk of a resources/read result — text or base64 blob. */
export interface McpResourceContent {
	uri?: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

export interface McpReadResourceResult {
	contents?: McpResourceContent[];
	[key: string]: unknown;
}

/** A prompt as described by a server's prompts/list response. */
export interface McpPromptDescriptor {
	name: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** One message of a prompts/get result. Content is text or a content-block array. */
export interface McpPromptMessage {
	role: string;
	content: string | McpContentBlock | McpContentBlock[];
}

export interface McpGetPromptResult {
	description?: string;
	messages?: McpPromptMessage[];
	[key: string]: unknown;
}

/** Parse one line of stdio output into a JSON-RPC message, or null if unparseable. */
export function parseRpcLine(line: string): JsonRpcResponse | JsonRpcNotification | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const msg = JSON.parse(trimmed);
		if (msg && typeof msg === "object" && msg.jsonrpc === "2.0") {
			return msg as JsonRpcResponse | JsonRpcNotification;
		}
	} catch {
		// Non-JSON line (server debug output on stdout, etc.) — ignore.
	}
	return null;
}

/** True when a parsed message is a response to one of our requests. */
export function isResponse(msg: JsonRpcResponse | JsonRpcNotification): msg is JsonRpcResponse {
	return typeof (msg as JsonRpcResponse).id === "number";
}
