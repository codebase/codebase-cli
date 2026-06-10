import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { CLIENT_INFO, type McpClient, REQUEST_TIMEOUT_MS } from "./client.js";
import {
	isResponse,
	type JsonRpcResponse,
	MCP_PROTOCOL_VERSION,
	type McpCallToolResult,
	type McpToolDescriptor,
	parseRpcLine,
} from "./protocol.js";

export interface StdioServerSpec {
	/** Executable to spawn (e.g. "npx", "uvx", "/usr/bin/mcp-server-foo"). */
	command: string;
	/** Arguments passed to the command. */
	args?: string[];
	/** Extra environment variables, merged over the process env. */
	env?: Record<string, string>;
	/** Working directory for the subprocess. Defaults to the agent's cwd. */
	cwd?: string;
}

/**
 * A JSON-RPC 2.0 client speaking MCP over a spawned subprocess's stdio.
 * Newline-delimited messages, request/response correlated by numeric id.
 *
 * Lifecycle: construct → connect() (spawns + handshake) → listTools() /
 * callTool() → close(). A spawn failure or server crash rejects all
 * pending requests so callers fail fast instead of hanging.
 */
export class StdioMcpClient implements McpClient {
	private child: ChildProcess | undefined;
	private rl: Interface | undefined;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private closed = false;

	constructor(
		readonly name: string,
		private readonly spec: StdioServerSpec,
	) {}

	/**
	 * Spawn the server and run the MCP handshake (initialize → initialized).
	 * Throws if the process can't spawn or the handshake fails/times out.
	 */
	async connect(): Promise<void> {
		const child = spawn(this.spec.command, this.spec.args ?? [], {
			cwd: this.spec.cwd,
			env: { ...process.env, ...this.spec.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.on("error", (err) => this.failAll(new Error(`MCP server "${this.name}" failed to spawn: ${err.message}`)));
		child.on("exit", (code, signal) => {
			if (!this.closed) {
				this.failAll(new Error(`MCP server "${this.name}" exited (code ${code ?? "?"}, signal ${signal ?? "?"})`));
			}
		});

		if (!child.stdout) throw new Error(`MCP server "${this.name}" has no stdout`);
		this.rl = createInterface({ input: child.stdout });
		this.rl.on("line", (line) => this.onLine(line));

		// Handshake. initialize → result → initialized notification.
		await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		this.notify("notifications/initialized");
	}

	/** Fetch the server's advertised tools. */
	async listTools(): Promise<McpToolDescriptor[]> {
		const res = await this.request("tools/list", {});
		const result = res.result as { tools?: McpToolDescriptor[] } | undefined;
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	/** Invoke a tool by name with arguments. Returns the server's result. */
	async callTool(name: string, args: unknown): Promise<McpCallToolResult> {
		const res = await this.request("tools/call", { name, arguments: args ?? {} });
		return (res.result as McpCallToolResult) ?? {};
	}

	/** Terminate the subprocess and reject any in-flight requests. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.rl?.close();
		this.failAll(new Error(`MCP server "${this.name}" client closed`));
		try {
			this.child?.kill("SIGTERM");
		} catch {
			// already gone
		}
	}

	private request(method: string, params: unknown): Promise<JsonRpcResponse> {
		if (this.closed || !this.child?.stdin) {
			return Promise.reject(new Error(`MCP server "${this.name}" is not connected`));
		}
		const id = this.nextId++;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP server "${this.name}" timed out on ${method} after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.child?.stdin?.write(payload);
		});
	}

	private notify(method: string, params?: unknown): void {
		if (this.closed || !this.child?.stdin) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private onLine(line: string): void {
		const msg = parseRpcLine(line);
		if (!msg || !isResponse(msg)) return; // notifications / server requests ignored in v1
		const entry = this.pending.get(msg.id);
		if (!entry) return;
		this.pending.delete(msg.id);
		clearTimeout(entry.timer);
		if (msg.error) {
			entry.reject(new Error(`MCP server "${this.name}" error on request ${msg.id}: ${msg.error.message}`));
		} else {
			entry.resolve(msg);
		}
	}

	private failAll(err: Error): void {
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this.pending.clear();
	}
}
