import { PassThrough } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAppServer } from "./server.js";

/**
 * App-server tests drive the server through real stdin/stdout streams
 * (PassThrough) so the JSON-RPC wire protocol gets exercised end to
 * end. The pi-ai faux provider stands in for a real model — that lets
 * us assert on prompt() round trips without env vars.
 */

type Outbound = { type: string } & Record<string, unknown>;

interface Harness {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	messages: Outbound[];
	donePromise: Promise<number>;
	send: (cmd: Record<string, unknown>) => void;
	waitFor: (predicate: (msg: Outbound) => boolean, timeoutMs?: number) => Promise<Outbound>;
	close: () => Promise<number>;
}

function makeHarness(opts: { model: Model<string> }): Harness {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const messages: Outbound[] = [];

	let buffer = "";
	const listeners: Array<(msg: Outbound) => void> = [];
	stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		while (true) {
			const nl = buffer.indexOf("\n");
			if (nl === -1) break;
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			const msg = JSON.parse(line) as Outbound;
			messages.push(msg);
			for (const l of [...listeners]) l(msg);
		}
	});

	const donePromise = runAppServer({
		stdin,
		stdout,
		stderr,
		autoApprove: true,
		configOverride: { model: opts.model, apiKey: "faux-key", source: "byok" },
	});

	const send = (cmd: Record<string, unknown>): void => {
		stdin.write(`${JSON.stringify(cmd)}\n`);
	};

	const waitFor = (predicate: (msg: Outbound) => boolean, timeoutMs = 2000): Promise<Outbound> => {
		const existing = messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.splice(listeners.indexOf(handler), 1);
				reject(new Error("waitFor timed out"));
			}, timeoutMs);
			const handler = (msg: Outbound) => {
				if (!predicate(msg)) return;
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(handler), 1);
				resolve(msg);
			};
			listeners.push(handler);
		});
	};

	const close = async (): Promise<number> => {
		stdin.end();
		return donePromise;
	};

	return { stdin, stdout, stderr, messages, donePromise, send, waitFor, close };
}

describe("runAppServer", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	let model: Model<string>;

	beforeEach(() => {
		faux = registerFauxProvider({
			models: [
				{
					id: "test-model",
					name: "Test Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
			tokenSize: { min: 1, max: 2 },
		});
		model = faux.models[0] as Model<string>;
	});

	afterEach(() => {
		faux.unregister();
	});

	it("emits server_ready on startup", async () => {
		const h = makeHarness({ model });
		const ready = await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		expect(ready).toBeTruthy();
		await h.close();
	});

	it("rejects commands before initialize", async () => {
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "1", type: "get_state" });
		const err = await h.waitFor((m) => m.type === "response" && m.id === "1");
		expect(err.success).toBe(false);
		expect(err.error).toMatch(/initialize/i);
		await h.close();
	});

	it("initializes successfully and returns model info", async () => {
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "init");
		expect(resp.success).toBe(true);
		const data = resp.data as { model: { id: string }; source: string };
		expect(data.model.id).toBe("test-model");
		expect(data.source).toBe("byok");
		await h.close();
	});

	it("routes a prompt through the agent and streams events back", async () => {
		faux.setResponses([fauxAssistantMessage("response from faux")]);
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");
		h.send({ id: "p1", type: "prompt", message: "hello" });
		const ack = await h.waitFor((m) => m.type === "response" && m.id === "p1");
		expect(ack.success).toBe(true);
		// Wait for agent_end on the event stream.
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "agent_end", 5000);
		// Some message_end events should have fired with our faux content.
		const messageEnds = h.messages.filter(
			(m) => m.type === "event" && (m.event as { type: string }).type === "message_end",
		);
		expect(messageEnds.length).toBeGreaterThan(0);
		await h.close();
	});

	it("get_state reports cwd, model, status, message count", async () => {
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");
		h.send({ id: "s", type: "get_state" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "s");
		expect(resp.success).toBe(true);
		const data = resp.data as { status: string; cwd: string; model: { id: string }; messageCount: number };
		expect(data.status).toBe("idle");
		expect(typeof data.cwd).toBe("string");
		expect(data.model.id).toBe("test-model");
		expect(data.messageCount).toBe(0);
		await h.close();
	});

	it("rejects a second prompt while one is in flight", async () => {
		faux.setResponses([fauxAssistantMessage("first response")]);
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");
		h.send({ id: "p1", type: "prompt", message: "first" });
		await h.waitFor((m) => m.type === "response" && m.id === "p1");
		// Don't wait for agent_end — send a second prompt immediately.
		h.send({ id: "p2", type: "prompt", message: "second" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "p2");
		expect(resp.success).toBe(false);
		expect(resp.error).toMatch(/in flight/i);
		await h.close();
	});

	it("rejects malformed JSON with a parse error", async () => {
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.stdin.write("not-json\n");
		const err = await h.waitFor((m) => m.type === "response" && m.command === "parse");
		expect(err.success).toBe(false);
		expect(err.error).toMatch(/parse/i);
		await h.close();
	});

	it("set_model returns the not-yet-supported error", async () => {
		const h = makeHarness({ model });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");
		h.send({ id: "m", type: "set_model", provider: "anthropic", modelId: "claude" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "m");
		expect(resp.success).toBe(false);
		expect(resp.error).toMatch(/not yet supported/i);
		await h.close();
	});
});
