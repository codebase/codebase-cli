import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpServers } from "./config.js";

describe("loadMcpServers", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "mcp-home-"));
		cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function write(root: string, obj: unknown): void {
		mkdirSync(join(root, ".codebase"), { recursive: true });
		writeFileSync(join(root, ".codebase", "mcp.json"), JSON.stringify(obj), "utf8");
	}

	it("returns [] when no config exists", () => {
		expect(loadMcpServers({ home, cwd })).toEqual([]);
	});

	it("parses a stdio server with args + env", () => {
		write(home, {
			mcpServers: {
				postgres: { command: "uvx", args: ["mcp-server-postgres"], env: { DATABASE_URL: "postgres://x" } },
			},
		});
		const servers = loadMcpServers({ home, cwd });
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("postgres");
		expect(servers[0].spec).toMatchObject({
			command: "uvx",
			args: ["mcp-server-postgres"],
			env: { DATABASE_URL: "postgres://x" },
		});
	});

	it("project config overrides user config on name collision", () => {
		write(home, { mcpServers: { fs: { command: "user-cmd" } } });
		write(cwd, { mcpServers: { fs: { command: "project-cmd" } } });
		const servers = loadMcpServers({ home, cwd });
		expect(servers).toHaveLength(1);
		expect(servers[0].spec.command).toBe("project-cmd");
	});

	it("skips remote (url) servers — stdio only in v1", () => {
		write(home, {
			mcpServers: {
				remote: { url: "https://mcp.example.com" },
				local: { command: "local-cmd" },
			},
		});
		const servers = loadMcpServers({ home, cwd });
		expect(servers.map((s) => s.name)).toEqual(["local"]);
	});

	it("skips entries missing a command", () => {
		write(home, { mcpServers: { broken: { args: ["x"] } } });
		expect(loadMcpServers({ home, cwd })).toEqual([]);
	});

	it("tolerates invalid JSON without throwing", () => {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "mcp.json"), "{ not json", "utf8");
		expect(loadMcpServers({ home, cwd })).toEqual([]);
	});
});
