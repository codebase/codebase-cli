import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "./manager.js";
import { mcpToolName } from "./to-agent-tool.js";

const MOCK = fileURLToPath(new URL("./__test__/mock-server.mjs", import.meta.url));

describe("McpManager (against the mock server)", () => {
	let home: string;
	let cwd: string;
	let manager: McpManager | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "mcpmgr-home-"));
		cwd = mkdtempSync(join(tmpdir(), "mcpmgr-cwd-"));
	});
	afterEach(() => {
		manager?.dispose();
		manager = undefined;
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeConfig(servers: Record<string, unknown>): void {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
	}

	it("connects a configured server and exposes its tools namespaced", async () => {
		writeConfig({ demo: { command: process.execPath, args: [MOCK] } });
		manager = new McpManager();
		await manager.connectAll({ home, cwd });

		const tools = manager.tools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe(mcpToolName("demo", "echo"));
		expect(tools[0].label).toBe("MCP: demo/echo");

		const status = manager.status();
		expect(status).toEqual([{ name: "demo", connected: true, toolCount: 1 }]);
	});

	it("a bridged tool forwards execute → callTool and flattens content", async () => {
		writeConfig({ demo: { command: process.execPath, args: [MOCK] } });
		manager = new McpManager();
		await manager.connectAll({ home, cwd });

		const echo = manager.tools()[0];
		const result = await echo.execute("tc", { text: "round trip" }, undefined, undefined);
		expect(result.content).toEqual([{ type: "text", text: "round trip" }]);
	});

	it("records a failed server without blocking others", async () => {
		writeConfig({
			good: { command: process.execPath, args: [MOCK] },
			bad: { command: "definitely-not-a-real-binary-xyz" },
		});
		manager = new McpManager();
		await manager.connectAll({ home, cwd });

		const status = manager.status();
		const good = status.find((s) => s.name === "good");
		const bad = status.find((s) => s.name === "bad");
		expect(good).toMatchObject({ connected: true, toolCount: 1 });
		expect(bad?.connected).toBe(false);
		expect(bad?.error).toBeTruthy();
		// The good server's tool is still available.
		expect(manager.tools()).toHaveLength(1);
	});

	it("yields no tools when no config exists", async () => {
		manager = new McpManager();
		await manager.connectAll({ home, cwd });
		expect(manager.tools()).toEqual([]);
		expect(manager.status()).toEqual([]);
	});

	it("aggregates resources and reads one by server + uri", async () => {
		writeConfig({ demo: { command: process.execPath, args: [MOCK] } });
		manager = new McpManager();
		await manager.connectAll({ home, cwd });

		const resources = manager.resources();
		expect(resources).toHaveLength(1);
		expect(resources[0]).toMatchObject({ server: "demo", descriptor: { uri: "mock://greeting", name: "greeting" } });

		const read = await manager.readResource("demo", "mock://greeting");
		expect(read.contents?.[0]).toMatchObject({ text: "hello from mock" });
	});

	it("connects a remote (url) server over HTTP and bridges its tools", async () => {
		const server = await startHttpMock();
		try {
			writeConfig({ remote: { url: server.url } });
			manager = new McpManager();
			await manager.connectAll({ home, cwd });
			expect(manager.status()).toEqual([{ name: "remote", connected: true, toolCount: 1 }]);
			expect(manager.tools()[0].name).toBe(mcpToolName("remote", "echo"));
		} finally {
			await server.close();
		}
	});
});

/** Minimal Streamable-HTTP MCP server: initialize → initialized → tools/list. */
async function startHttpMock(): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : {};
			if (body.method === "notifications/initialized") {
				res.statusCode = 202;
				res.end();
				return;
			}
			const result =
				body.method === "tools/list"
					? { tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }] }
					: { protocolVersion: "2025-06-18", capabilities: {} };
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
