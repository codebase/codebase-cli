import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialsStore } from "../auth/credentials.js";
import { ConfigStore } from "../config/store.js";
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

function makeHarness(opts: { model?: Model<string>; autoApprove?: boolean; cwd?: string }): Harness {
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
		autoApprove: opts.autoApprove ?? true,
		cwd: opts.cwd,
		configOverride: opts.model ? { model: opts.model, apiKey: "faux-key", source: "byok" } : undefined,
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
	let home: string;
	let cwd: string;
	let prevHome: string | undefined;
	let prevNoAutoMemory: string | undefined;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevNoAutoMemory = process.env.CODEBASE_NO_AUTO_MEMORY;
		home = mkdtempSync(join(tmpdir(), "app-server-home-"));
		cwd = mkdtempSync(join(tmpdir(), "app-server-cwd-"));
		process.env.HOME = home;
		process.env.CODEBASE_NO_AUTO_MEMORY = "1";
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
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevNoAutoMemory === undefined) delete process.env.CODEBASE_NO_AUTO_MEMORY;
		else process.env.CODEBASE_NO_AUTO_MEMORY = prevNoAutoMemory;
	});

	it("emits server_ready on startup", async () => {
		const h = makeHarness({ model, cwd });
		const ready = await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		expect(ready).toBeTruthy();
		await h.close();
	});

	it("rejects commands before initialize", async () => {
		const h = makeHarness({ model, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "1", type: "get_state" });
		const err = await h.waitFor((m) => m.type === "response" && m.id === "1");
		expect(err.success).toBe(false);
		expect(err.error).toMatch(/initialize/i);
		await h.close();
	});

	it("initializes successfully and returns model info", async () => {
		const h = makeHarness({ model, cwd });
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
		const h = makeHarness({ model, cwd });
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
		const h = makeHarness({ model, cwd });
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

	it("serves code navigation results directly to app clients", async () => {
		writeCodeNavFixture(cwd);
		const h = makeHarness({ model, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");

		h.send({ id: "nav", type: "code_navigation", operation: "symbols", path: "src/util.ts", query: "make" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "nav");

		expect(resp.success).toBe(true);
		const data = resp.data as { text: string; details: { operation: string; results: Array<{ file: string }> } };
		expect(data.text).toContain("src/util.ts:1:1 function makeGreeting");
		expect(data.details.operation).toBe("symbols");
		expect(data.details.results[0].file).toBe("src/util.ts");
		await h.close();
	});

	it("serves TypeScript diagnostics directly to app clients", async () => {
		writeCodeNavFixture(cwd);
		const h = makeHarness({ model, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");

		h.send({ id: "diag", type: "code_navigation", operation: "diagnostics", path: "src/main.ts" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "diag");

		expect(resp.success).toBe(true);
		const data = resp.data as { text: string; details: { operation: string } };
		expect(data.details.operation).toBe("diagnostics");
		expect(data.text).toContain("TS2322");
		expect(data.text).toContain("Type 'string' is not assignable to type 'number'");
		await h.close();
	});

	it("validates app-server code navigation requests", async () => {
		const h = makeHarness({ model, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");

		h.send({ id: "bad-nav", type: "code_navigation", operation: "symbols", path: "src/nope.ts", max_results: 0 });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "bad-nav");

		expect(resp.success).toBe(false);
		expect(resp.error).toContain("max_results");
		await h.close();
	});

	it("rejects a second prompt while one is in flight", async () => {
		faux.setResponses([fauxAssistantMessage("first response")]);
		const h = makeHarness({ model, cwd });
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

	it("forwards permission reason and trust scope to app clients", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("shell", { command: 'git commit -m "bridge"' }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Permission denied, so I stopped."),
		]);
		const h = makeHarness({ model, autoApprove: false, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		await h.waitFor((m) => m.type === "response" && m.id === "init");
		h.send({ id: "p1", type: "prompt", message: "commit the change" });
		await h.waitFor((m) => m.type === "response" && m.id === "p1");

		const event = await h.waitFor(
			(m) => m.type === "event" && (m.event as { type: string }).type === "permission_request",
			5000,
		);
		const request = (event.event as { request: Record<string, unknown> }).request;
		expect(request.tool).toBe("shell");
		expect(request.reason).toContain("local git history");
		expect(request.trustScope).toBe("shell:git commit*");
		expect(request.guidance).toContain('Persist exact allow: /permissions allow shell:git commit -m "bridge"');
		expect(request.guidance).toContain("Persist family allow: /permissions allow shell:git commit*");

		h.send({ id: "perm", type: "permission_respond", requestId: request.id, choice: "deny" });
		const response = await h.waitFor((m) => m.type === "response" && m.id === "perm");
		expect(response.success).toBe(true);
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "permission_cleared");
		await h.close();
	});

	it("rejects malformed JSON with a parse error", async () => {
		const h = makeHarness({ model, cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.stdin.write("not-json\n");
		const err = await h.waitFor((m) => m.type === "response" && m.command === "parse");
		expect(err.success).toBe(false);
		expect(err.error).toMatch(/parse/i);
		await h.close();
	});

	it("set_model switches the app-server bundle and persists the preference", async () => {
		new CredentialsStore().save({
			accessToken: "oauth-token",
			scopes: ["inference"],
			source: "codebase",
		});
		const h = makeHarness({ cwd });
		await h.waitFor((m) => m.type === "event" && (m.event as { type: string }).type === "server_ready");
		h.send({ id: "init", type: "initialize" });
		const init = await h.waitFor((m) => m.type === "response" && m.id === "init");
		expect((init.data as { model: { id: string } }).model.id).toBe("d4f");
		h.send({ id: "m", type: "set_model", provider: "codebase", modelId: "deepseek-r1:14b" });
		const resp = await h.waitFor((m) => m.type === "response" && m.id === "m");
		expect(resp.success).toBe(true);
		expect((resp.data as { id: string; provider: string }).id).toBe("deepseek-r1:14b");
		expect((resp.data as { id: string; provider: string }).provider).toBe("codebase");
		h.send({ id: "s2", type: "get_state" });
		const state = await h.waitFor((m) => m.type === "response" && m.id === "s2");
		expect((state.data as { model: { id: string } }).model.id).toBe("deepseek-r1:14b");
		expect(new ConfigStore({ home, cwd }).preferredModel()).toEqual({
			provider: "codebase",
			modelId: "deepseek-r1:14b",
		});
		await h.close();
	});
});

function writeCodeNavFixture(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(
		join(cwd, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "Node16",
				moduleResolution: "Node16",
				strict: true,
			},
			include: ["src/**/*.ts"],
		}),
	);
	writeFileSync(
		join(cwd, "src", "util.ts"),
		["export function makeGreeting(name: string): string {", '  return "hello " + name;', "}", ""].join("\n"),
	);
	writeFileSync(
		join(cwd, "src", "main.ts"),
		[
			'import { makeGreeting } from "./util";',
			"",
			"const count: number = makeGreeting(123);",
			"console.log(count);",
			"",
		].join("\n"),
	);
}
