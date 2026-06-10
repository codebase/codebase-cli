import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpContentBlock, McpToolDescriptor } from "./protocol.js";
import type { StdioMcpClient } from "./stdio-client.js";

/**
 * Namespaced tool name: `mcp__<server>__<tool>`. Mirrors Claude Code so
 * a remote tool can't collide with one of our 32 built-ins, and the
 * model can see at a glance which server a tool came from.
 */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`;
}

/**
 * Bridge one MCP tool descriptor into an AgentTool. The server's
 * JSON Schema becomes the tool's `parameters` verbatim — pi-agent-core
 * forwards it to the provider and passes the model's arguments straight
 * to execute without TypeBox validation, so a raw JSON Schema works.
 * execute() forwards the call to the live MCP client and flattens the
 * result's content blocks into the agent's text/image content shape.
 */
export function mcpToAgentTool(server: string, client: StdioMcpClient, desc: McpToolDescriptor): AgentTool<any> {
	const schema = desc.inputSchema ?? { type: "object", properties: {} };
	return {
		name: mcpToolName(server, desc.name),
		label: `MCP: ${server}/${desc.name}`,
		description: desc.description ?? `MCP tool ${desc.name} from server ${server}.`,
		// JSON Schema stands in for the TypeBox TSchema. pi-agent-core
		// forwards parameters to the provider and passes args to execute
		// without runtime validation, so a raw JSON Schema works here.
		parameters: schema as AgentTool<never>["parameters"],
		execute: async (_toolCallId, params) => {
			const result = await client.callTool(desc.name, params);
			const content = flattenContent(result.content ?? []);
			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: "(no content returned)" }],
				details: { server, tool: desc.name, isError: result.isError === true },
			};
		},
	};
}

/**
 * Convert MCP content blocks to the agent's content shape. Text and
 * image pass through; anything else is rendered as a labeled text block
 * so nothing is silently dropped.
 */
function flattenContent(
	blocks: McpContentBlock[],
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			out.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.data === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
		} else {
			// resource links, embedded resources, audio, etc. — keep the
			// model informed rather than dropping the block.
			out.push({ type: "text", text: `[${block.type} content]` });
		}
	}
	return out;
}
