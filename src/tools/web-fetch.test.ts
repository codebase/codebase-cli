import { type AddressInfo, createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import type { ToolContext } from "./types.js";
import { createWebFetch } from "./web-fetch.js";

type RouteHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

let server: Server;
let baseUrl: string;
const routes: Record<string, RouteHandler> = {};

beforeAll(async () => {
	server = createServer((req, res) => {
		const handler = routes[req.url ?? "/"];
		if (handler) {
			handler(req, res);
		} else {
			res.statusCode = 404;
			res.end("not found");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeCtx(): ToolContext {
	return { cwd: process.cwd(), fileStateCache: new FileStateCache() };
}

async function fetchUrl(params: Parameters<ReturnType<typeof createWebFetch>["execute"]>[1]) {
	return createWebFetch(makeCtx()).execute("call", params);
}

describe("web_fetch", () => {
	it("fetches a simple GET", async () => {
		routes["/hello"] = (_req, res) => {
			res.setHeader("Content-Type", "text/plain");
			res.end("hello world");
		};

		const result = await fetchUrl({ url: `${baseUrl}/hello` });
		expect(result.details.status).toBe(200);
		expect(result.details.contentType).toMatch(/text\/plain/);
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("hello world");
	});

	it("captures non-2xx status without throwing", async () => {
		routes["/missing"] = (_req, res) => {
			res.statusCode = 404;
			res.end("not here");
		};

		const result = await fetchUrl({ url: `${baseUrl}/missing` });
		expect(result.details.status).toBe(404);
	});

	it("truncates oversized bodies and reports it", async () => {
		const big = "A".repeat(50_000);
		routes["/big"] = (_req, res) => {
			res.end(big);
		};

		const result = await fetchUrl({ url: `${baseUrl}/big`, max_bytes: 1024 });
		expect(result.details.truncated).toBe(true);
		expect(result.details.bytes).toBeGreaterThanOrEqual(1024);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/truncated/);
	});

	it("forwards request headers", async () => {
		let seen = "";
		routes["/echo"] = (req, res) => {
			seen = String(req.headers["x-test"] ?? "");
			res.end("ok");
		};

		await fetchUrl({ url: `${baseUrl}/echo`, headers: { "X-Test": "from-tool" } });
		expect(seen).toBe("from-tool");
	});

	it("returns no body for HEAD requests", async () => {
		routes["/head"] = (_req, res) => {
			res.setHeader("Content-Length", "11");
			res.setHeader("Content-Type", "text/plain");
			res.end("hello world");
		};

		const result = await fetchUrl({ url: `${baseUrl}/head`, method: "HEAD" });
		expect(result.details.bytes).toBe(0);
		expect((result.content[0] as { type: "text"; text: string }).text).not.toContain("hello world");
	});

	it("rejects non-http(s) URLs", async () => {
		await expect(fetchUrl({ url: "file:///etc/passwd" })).rejects.toThrow(/must be http or https/);
	});

	it("rejects malformed URLs", async () => {
		await expect(fetchUrl({ url: "not a url" })).rejects.toThrow(/Invalid URL/);
	});

	it("times out a slow response", async () => {
		routes["/slow"] = (_req, res) => {
			setTimeout(() => res.end("late"), 1000);
		};

		await expect(fetchUrl({ url: `${baseUrl}/slow`, timeout_ms: 100 })).rejects.toThrow(/timed out|aborted/i);
	});
});
