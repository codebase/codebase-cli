import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type LoadMcpConfigOptions, loadMcpServers } from "./config.js";
import { StdioMcpClient } from "./stdio-client.js";
import { mcpToAgentTool } from "./to-agent-tool.js";

export interface McpServerStatus {
	name: string;
	connected: boolean;
	toolCount: number;
	error?: string;
}

/**
 * Owns the lifecycle of every configured MCP server: spawns each stdio
 * server, runs the handshake, collects its tools, and exposes them as
 * AgentTools the agent can call. A server that fails to connect is
 * recorded (status.error) and skipped — one broken server never blocks
 * the others or the agent's own built-in tools.
 *
 * connectAll() is best-effort and resolves once every server has either
 * connected or failed. dispose() terminates all subprocesses.
 */
export class McpManager {
	private readonly clients: StdioMcpClient[] = [];
	private readonly statuses: McpServerStatus[] = [];
	private readonly toolList: AgentTool<any>[] = [];

	/**
	 * Load config + connect every configured stdio server. Tools are
	 * collected as servers come up. Returns once all have settled. Safe
	 * to call when no config exists — yields zero tools.
	 */
	async connectAll(options: LoadMcpConfigOptions = {}): Promise<void> {
		const servers = loadMcpServers(options);
		await Promise.all(
			servers.map(async ({ name, spec }) => {
				const client = new StdioMcpClient(name, spec);
				try {
					await client.connect();
					const descriptors = await client.listTools();
					this.clients.push(client);
					for (const desc of descriptors) {
						this.toolList.push(mcpToAgentTool(name, client, desc));
					}
					this.statuses.push({ name, connected: true, toolCount: descriptors.length });
				} catch (err) {
					client.close();
					this.statuses.push({
						name,
						connected: false,
						toolCount: 0,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}),
		);
	}

	/** All successfully-bridged MCP tools. */
	tools(): AgentTool<any>[] {
		return this.toolList;
	}

	/** Per-server connection status, for `/mcp` and diagnostics. */
	status(): readonly McpServerStatus[] {
		return this.statuses;
	}

	/** Terminate every server subprocess. Idempotent. */
	dispose(): void {
		for (const client of this.clients) client.close();
	}
}
