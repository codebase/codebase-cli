import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StdioMcpClient } from "./stdio-client.js";

const MOCK = fileURLToPath(new URL("./__test__/mock-server.mjs", import.meta.url));

describe("StdioMcpClient (against a real mock subprocess)", () => {
	let client: StdioMcpClient | undefined;

	afterEach(() => {
		client?.close();
		client = undefined;
	});

	it("connects, lists tools, and calls a tool round-trip", async () => {
		client = new StdioMcpClient("mock", { command: process.execPath, args: [MOCK] });
		await client.connect();

		const tools = await client.listTools();
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "echo", description: "Echo back the text argument." });
		expect(tools[0].inputSchema).toMatchObject({ type: "object" });

		const result = await client.callTool("echo", { text: "hello mcp" });
		expect(result.content?.[0]).toEqual({ type: "text", text: "hello mcp" });
	});

	it("surfaces a server error response as a rejection", async () => {
		client = new StdioMcpClient("mock", { command: process.execPath, args: [MOCK] });
		await client.connect();
		await expect(client.callTool("nope", {})).rejects.toThrow(/unknown tool: nope/);
	});

	it("rejects pending requests when the server process exits", async () => {
		client = new StdioMcpClient("mock", { command: process.execPath, args: [MOCK] });
		await client.connect();
		const pending = client.listTools();
		client.close(); // kills the subprocess
		await expect(pending).rejects.toThrow(/closed|exited/);
	});

	it("fails to connect when the command can't spawn", async () => {
		client = new StdioMcpClient("bad", { command: "this-command-does-not-exist-xyz", args: [] });
		await expect(client.connect()).rejects.toThrow();
	});
});
