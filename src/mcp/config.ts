import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StdioServerSpec } from "./stdio-client.js";

/**
 * MCP server config, loaded from `~/.codebase/mcp.json` (user) and
 * `<cwd>/.codebase/mcp.json` (project). Project entries override user
 * entries with the same name. Matches the de-facto `mcpServers` schema
 * so existing Claude Desktop / Cursor / Claude Code configs port over:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
 *       },
 *       "postgres": {
 *         "command": "uvx",
 *         "args": ["mcp-server-postgres"],
 *         "env": { "DATABASE_URL": "postgres://…" }
 *       }
 *     }
 *   }
 *
 * v1 supports stdio servers only. Entries with a `url` (remote HTTP/SSE
 * servers) are skipped with a one-line note — that transport is a
 * planned follow-up.
 */
export interface NamedServer {
	name: string;
	spec: StdioServerSpec;
}

export interface LoadMcpConfigOptions {
	home?: string;
	cwd?: string;
}

export function loadMcpServers(options: LoadMcpConfigOptions = {}): NamedServer[] {
	const home = options.home ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const byName = new Map<string, NamedServer>();
	// User layer first, then project so project wins on name collision.
	for (const path of [join(home, ".codebase", "mcp.json"), join(cwd, ".codebase", "mcp.json")]) {
		for (const server of readConfigFile(path, cwd)) byName.set(server.name, server);
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function readConfigFile(path: string, cwd: string): NamedServer[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			process.stderr.write(`[mcp] could not read ${path}: ${(err as Error).message}\n`);
		}
		return [];
	}
	let parsed: { mcpServers?: Record<string, unknown> };
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		process.stderr.write(`[mcp] invalid JSON in ${path}: ${(err as Error).message}\n`);
		return [];
	}
	const servers = parsed.mcpServers;
	if (!servers || typeof servers !== "object") return [];

	const out: NamedServer[] = [];
	for (const [name, value] of Object.entries(servers)) {
		const entry = value as Record<string, unknown>;
		if (typeof entry?.url === "string") {
			process.stderr.write(`[mcp] skipping "${name}": remote (url) servers aren't supported yet — stdio only.\n`);
			continue;
		}
		if (typeof entry?.command !== "string" || !entry.command.trim()) {
			process.stderr.write(`[mcp] skipping "${name}": missing "command".\n`);
			continue;
		}
		const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined;
		let env: Record<string, string> | undefined;
		if (entry.env && typeof entry.env === "object") {
			env = {};
			for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
				if (typeof v === "string") env[k] = v;
			}
		}
		out.push({ name, spec: { command: entry.command, args, env, cwd } });
	}
	return out;
}
