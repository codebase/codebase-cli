import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HttpServerSpec } from "./http-client.js";
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
 * Two transports: a `command` entry spawns a stdio subprocess; a `url`
 * entry talks Streamable HTTP to a remote server. Optional `headers` on
 * a remote entry carry static auth (e.g. a bearer token).
 */
export type NamedServer =
	| { name: string; transport: "stdio"; spec: StdioServerSpec }
	| { name: string; transport: "http"; spec: HttpServerSpec };

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
		if (typeof entry?.url === "string" && entry.url.trim()) {
			out.push({ name, transport: "http", spec: { url: entry.url, headers: strMap(entry.headers) } });
			continue;
		}
		if (typeof entry?.command !== "string" || !entry.command.trim()) {
			process.stderr.write(`[mcp] skipping "${name}": needs a "command" (stdio) or "url" (remote).\n`);
			continue;
		}
		const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined;
		out.push({ name, transport: "stdio", spec: { command: entry.command, args, env: strMap(entry.env), cwd } });
	}
	return out;
}

/** Coerce an unknown config value into a string→string map, dropping non-string values. */
function strMap(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
