import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// Mirrors codebase-cli/src/app-server/protocol.ts. Kept inline (no
// shared types package) so the extension is self-contained and can be
// pushed to the marketplace without a workspace dependency.

export interface RpcClientOptions {
	binaryPath: string;
	cwd: string;
	resume?: boolean;
	env?: NodeJS.ProcessEnv;
}

export interface ServerEvent {
	type: string;
	[k: string]: unknown;
}

interface PendingRequest {
	resolve: (value: ServerResponse) => void;
	reject: (err: Error) => void;
	timeout: NodeJS.Timeout;
}

interface ServerResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/**
 * Thin wrapper around a spawned `codebase app-server` process. Speaks
 * the same JSON-RPC-ish envelope the CLI does. EventEmitter for
 * unsolicited notifications:
 *
 *   client.on("event", (e) => …)        — every agent event
 *   client.on("disconnect", () => …)    — child exited unexpectedly
 *   client.on("server_ready", () => …)  — initial handshake signal
 */
export class RpcClient extends EventEmitter {
	private child: ChildProcessWithoutNullStreams | null = null;
	private reader: Interface | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private serverReady = false;
	private disposed = false;

	constructor(private readonly opts: RpcClientOptions) {
		super();
	}

	async start(): Promise<void> {
		if (this.child) throw new Error("RpcClient already started");
		const args = ["app-server"];
		if (this.opts.resume) args.push("--resume");

		this.child = spawn(this.opts.binaryPath, args, {
			cwd: this.opts.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.reader = createInterface({ input: this.child.stdout });

		this.reader.on("line", (line) => this.handleLine(line));

		this.child.stderr.on("data", (chunk) => {
			// Surface to extension host log so users can debug auth/config errors.
			this.emit("stderr", chunk.toString());
		});

		this.child.on("exit", (code) => {
			this.emit("disconnect", code);
			this.disposed = true;
			for (const p of this.pending.values()) {
				clearTimeout(p.timeout);
				p.reject(new Error("server exited"));
			}
			this.pending.clear();
		});

		this.child.on("error", (err) => {
			this.emit("error", err);
		});

		// Wait for the initial server_ready event so the caller doesn't
		// race against startup.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("server did not signal ready within 10s")), 10_000);
			this.once("server_ready", () => {
				clearTimeout(timer);
				resolve();
			});
			this.once("disconnect", () => {
				clearTimeout(timer);
				reject(new Error("server exited before ready"));
			});
		});
	}

	async initialize(clientInfo: { name: string; version: string; title?: string }): Promise<unknown> {
		return this.request("initialize", { clientInfo });
	}

	async prompt(message: string): Promise<unknown> {
		return this.request("prompt", { message });
	}

	async abort(): Promise<unknown> {
		return this.request("abort", {});
	}

	async getState(): Promise<unknown> {
		return this.request("get_state", {});
	}

	async getMessages(): Promise<unknown> {
		return this.request("get_messages", {});
	}

	async permissionRespond(
		requestId: string,
		choice: "allow-once" | "trust-tool" | "trust-all" | "deny",
	): Promise<unknown> {
		return this.request("permission_respond", { requestId, choice });
	}

	dispose(): void {
		this.disposed = true;
		this.reader?.close();
		this.child?.kill("SIGTERM");
		setTimeout(() => this.child?.kill("SIGKILL"), 2_000);
	}

	get isReady(): boolean {
		return this.serverReady && !this.disposed;
	}

	// ── internals ────────────────────────────────────────────────────

	private async request(type: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.child || this.disposed) throw new Error("RpcClient not started or already disposed");
		const id = randomUUID();
		const payload = { id, type, ...params };
		return new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`request "${type}" timed out`));
			}, 30_000);

			this.pending.set(id, {
				resolve: (res) => {
					if (res.success) resolve(res.data ?? null);
					else reject(new Error(res.error ?? `request "${type}" failed`));
				},
				reject,
				timeout,
			});

			this.child?.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
				if (err) {
					clearTimeout(timeout);
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: { type?: string } & Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return;
		}

		if (parsed.type === "response") {
			const res = parsed as unknown as ServerResponse;
			if (res.id && this.pending.has(res.id)) {
				const p = this.pending.get(res.id);
				if (p) {
					clearTimeout(p.timeout);
					this.pending.delete(res.id);
					p.resolve(res);
				}
			}
			return;
		}

		if (parsed.type === "event") {
			const ev = (parsed as unknown as { event: ServerEvent }).event;
			if (ev?.type === "server_ready") {
				this.serverReady = true;
				this.emit("server_ready");
				return;
			}
			this.emit("event", ev);
			return;
		}
	}
}
