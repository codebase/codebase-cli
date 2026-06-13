import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

/**
 * Two read-only tools that expose MCP server *resources* (files, records,
 * docs a server publishes) to the agent — the counterpart to the tools
 * MCP servers expose. list_mcp_resources enumerates them;
 * read_mcp_resource pulls one in by server + URI.
 */

const ListParams = Type.Object({});

const ReadParams = Type.Object({
	server: Type.String({ description: "MCP server name that owns the resource (from list_mcp_resources)." }),
	uri: Type.String({ description: "Resource URI to read (from list_mcp_resources)." }),
});
export type ReadMcpResourceParams = Static<typeof ReadParams>;

export function createMcpResourceTools(ctx: ToolContext): AgentTool<any>[] {
	const list: AgentTool<typeof ListParams> = {
		name: "list_mcp_resources",
		label: "MCP resources",
		description:
			"List resources published by connected MCP servers (server, URI, name, type). Read one with read_mcp_resource.",
		parameters: ListParams,
		execute: async () => {
			const resources = ctx.mcp?.resources() ?? [];
			if (resources.length === 0) {
				return { content: [{ type: "text", text: "No MCP resources available." }], details: { count: 0 } };
			}
			const lines = resources.map((r) => {
				const d = r.descriptor;
				const meta = [d.name && `name: ${d.name}`, d.mimeType && `type: ${d.mimeType}`].filter(Boolean).join(", ");
				return `- ${r.server} :: ${d.uri}${meta ? ` (${meta})` : ""}${d.description ? ` — ${d.description}` : ""}`;
			});
			return {
				content: [{ type: "text", text: `MCP resources:\n${lines.join("\n")}` }],
				details: { count: resources.length },
			};
		},
	};

	const read: AgentTool<typeof ReadParams> = {
		name: "read_mcp_resource",
		label: "Read MCP resource",
		description: "Read one MCP resource by server name + URI. Returns its text content.",
		parameters: ReadParams,
		execute: async (_id, params) => {
			if (!ctx.mcp) {
				return { content: [{ type: "text", text: "No MCP servers are connected." }], details: { isError: true } };
			}
			const result = await ctx.mcp.readResource(params.server, params.uri);
			const contents = result.contents ?? [];
			if (contents.length === 0) {
				return { content: [{ type: "text", text: `(resource ${params.uri} returned no content)` }], details: {} };
			}
			const parts = contents.map((c) => {
				if (typeof c.text === "string") return c.text;
				if (typeof c.blob === "string") return `[binary ${c.mimeType ?? "data"}, ${c.blob.length} base64 chars]`;
				return "";
			});
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { server: params.server, uri: params.uri },
			};
		},
	};

	return [list, read];
}
