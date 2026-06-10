#!/usr/bin/env node
// Minimal MCP stdio server for tests. Speaks newline-delimited JSON-RPC 2.0:
// handles initialize, tools/list, tools/call. One tool, "echo", that returns
// its `text` argument. Exits when stdin closes.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "mock", version: "0" },
			},
		});
		return;
	}
	if (msg.method === "notifications/initialized") return; // no response
	if (msg.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echo back the text argument.",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
		});
		return;
	}
	if (msg.method === "tools/call") {
		const { name, arguments: args } = msg.params ?? {};
		if (name === "echo") {
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { content: [{ type: "text", text: String(args?.text ?? "") }] },
			});
		} else {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool: ${name}` } });
		}
		return;
	}
	// Unknown method → error response.
	if (typeof msg.id === "number") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
	}
});

rl.on("close", () => process.exit(0));
