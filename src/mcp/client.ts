import type { McpCallToolResult, McpToolDescriptor } from "./protocol.js";

/** What every MCP client speaks to, regardless of transport (stdio | http). */
export const CLIENT_INFO = { name: "codebase-cli", version: "1" } as const;

/** Default per-request timeout shared by all transports. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transport-agnostic MCP client. `manager.ts` and `to-agent-tool.ts`
 * depend only on this surface, so a stdio subprocess and a remote HTTP
 * endpoint are interchangeable behind it.
 */
export interface McpClient {
	readonly name: string;
	/** Spawn/open the transport and run the MCP handshake. */
	connect(): Promise<void>;
	/** Fetch the server's advertised tools. */
	listTools(): Promise<McpToolDescriptor[]>;
	/** Invoke a tool by name with arguments. */
	callTool(name: string, args: unknown): Promise<McpCallToolResult>;
	/** Tear down the transport and reject any in-flight requests. */
	close(): void;
}
