import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "../types.js";

/**
 * /mcp — show connected MCP servers and their tool counts, or guidance
 * on configuring them when none are set up. MCP servers extend the
 * agent with external tools (filesystem, Postgres, git, fetch, …)
 * without us writing each integration.
 */
export const mcp: Command = {
	name: "mcp",
	description: "Show connected MCP servers and their tools.",
	handler: (_args, ctx) => {
		const statuses = ctx.bundle.mcp.status();
		if (statuses.length === 0) {
			ctx.emit("No MCP servers configured.");
			ctx.emit(
				`Add stdio servers in ${join(homedir(), ".codebase", "mcp.json")} (or <project>/.codebase/mcp.json):`,
			);
			ctx.emit("  {");
			ctx.emit('    "mcpServers": {');
			ctx.emit('      "filesystem": {');
			ctx.emit('        "command": "npx",');
			ctx.emit('        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]');
			ctx.emit("      },");
			ctx.emit('      "remote": {');
			ctx.emit('        "url": "https://mcp.example.com/sse",');
			ctx.emit('        "headers": { "Authorization": "Bearer <token>" }');
			ctx.emit("      }");
			ctx.emit("    }");
			ctx.emit("  }");
			ctx.emit("Restart codebase to connect. Both stdio (command) and remote (url) servers are supported.");
			return { handled: true };
		}

		ctx.emit("MCP servers:");
		for (const s of statuses) {
			if (s.connected) {
				ctx.emit(`  ✓ ${s.name} — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
			} else {
				ctx.emit(`  ✗ ${s.name} — failed: ${s.error ?? "unknown"}`);
			}
		}
		const tools = ctx.bundle.mcp.tools();
		if (tools.length > 0) {
			ctx.emit("Tools:");
			for (const t of tools) ctx.emit(`  ${t.name}`);
		}
		const resources = ctx.bundle.mcp.resources();
		if (resources.length > 0) {
			ctx.emit("Resources (read via read_mcp_resource):");
			for (const r of resources) ctx.emit(`  ${r.server} :: ${r.descriptor.uri}`);
		}
		const prompts = ctx.bundle.mcp.prompts();
		if (prompts.length > 0) {
			ctx.emit("Prompts (run as slash commands):");
			for (const p of prompts) ctx.emit(`  /mcp__${p.server}__${p.descriptor.name}`);
		}
		return { handled: true };
	},
};
