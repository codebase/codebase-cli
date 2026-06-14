import type {
	McpCallToolResult,
	McpGetPromptResult,
	McpPromptDescriptor,
	McpReadResourceResult,
	McpResourceDescriptor,
	McpToolDescriptor,
} from "./protocol.js";

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
	/** List the server's resources. Returns [] when the server has no resources capability. */
	listResources(): Promise<McpResourceDescriptor[]>;
	/** Read one resource by URI. */
	readResource(uri: string): Promise<McpReadResourceResult>;
	/** List the server's prompts. Returns [] when the server has no prompts capability. */
	listPrompts(): Promise<McpPromptDescriptor[]>;
	/** Expand a prompt by name with arguments. */
	getPrompt(name: string, args: Record<string, string>): Promise<McpGetPromptResult>;
	/** Tear down the transport and reject any in-flight requests. */
	close(): void;
}
