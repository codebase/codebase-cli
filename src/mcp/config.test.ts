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
		const server = servers[0];
		expect(server.name).toBe("postgres");
		expect(server.transport).toBe("stdio");
		if (server.transport !== "stdio") throw new Error("expected stdio");
		expect(server.spec).toMatchObject({
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
		const server = servers[0];
		if (server.transport !== "stdio") throw new Error("expected stdio");
		expect(server.spec.command).toBe("project-cmd");
	});

	it("parses a remote (url) server with headers as http transport", () => {
		write(home, {
			mcpServers: {
				remote: { url: "https://mcp.example.com", headers: { Authorization: "Bearer t0ken" } },
				local: { command: "local-cmd" },
			},
		});
		const servers = loadMcpServers({ home, cwd });
		expect(servers.map((s) => s.name)).toEqual(["local", "remote"]);
		const remote = servers.find((s) => s.name === "remote");
		if (remote?.transport !== "http") throw new Error("expected http");
		expect(remote.spec).toEqual({ url: "https://mcp.example.com", headers: { Authorization: "Bearer t0ken" } });
	});

	it("skips entries with neither command nor url", () => {
		write(home, { mcpServers: { broken: { args: ["x"] } } });
		expect(loadMcpServers({ home, cwd })).toEqual([]);
	});

	it("tolerates invalid JSON without throwing", () => {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "mcp.json"), "{ not json", "utf8");
		expect(loadMcpServers({ home, cwd })).toEqual([]);
	});
});
