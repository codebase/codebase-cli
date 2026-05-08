import { type AddressInfo, createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";
import { createWebSearch, pickProvider } from "./web-search.js";

type RouteHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

let server: Server;
let baseUrl: string;
const routes: Record<string, RouteHandler> = {};

beforeAll(async () => {
	server = createServer((req, res) => {
		const handler = routes[req.url?.split("?")[0] ?? "/"];
		if (handler) handler(req, res);
		else {
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
	return { cwd: process.cwd(), fileStateCache: new FileStateCache(), tasks: new TaskStore() };
}

async function search(env: NodeJS.ProcessEnv, params: { query: string; max_results?: number }) {
	const original = { ...process.env };
	Object.assign(process.env, env);
	try {
		return await createWebSearch(makeCtx()).execute("call", params);
	} finally {
		for (const key of Object.keys(env)) delete process.env[key];
		Object.assign(process.env, original);
	}
}

describe("web_search provider selection", () => {
	it("prefers Tavily when TAVILY_API_KEY is set", () => {
		expect(pickProvider({ TAVILY_API_KEY: "x" }).name).toBe("tavily");
	});

	it("falls back to Brave when only BRAVE_API_KEY is set", () => {
		expect(pickProvider({ BRAVE_API_KEY: "x" }).name).toBe("brave");
	});

	it("uses SearXNG only when nothing else is configured", () => {
		expect(pickProvider({ SEARXNG_URL: "http://localhost:8080" }).name).toBe("searxng");
	});

	it("Tavily wins over Brave when both keys are set", () => {
		expect(pickProvider({ TAVILY_API_KEY: "x", BRAVE_API_KEY: "y" }).name).toBe("tavily");
	});

	it("errors with onboarding when nothing is configured", () => {
		expect(() => pickProvider({})).toThrow(/TAVILY_API_KEY/);
	});
});

describe("web_search end-to-end via mock servers", () => {
	it("calls Tavily and parses results", async () => {
		routes["/search"] = (req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (b) => chunks.push(b));
			req.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				expect(body.query).toBe("hello");
				expect(body.max_results).toBe(3);
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						results: [
							{ title: "Hello, World!", url: "https://example.com/hello", content: "Greetings." },
							{ title: "Hello docs", url: "https://example.com/docs", content: "Reference." },
						],
					}),
				);
			});
		};

		const result = await search(
			{ TAVILY_API_KEY: "fake-key", TAVILY_BASE_URL: baseUrl },
			{ query: "hello", max_results: 3 },
		);
		expect(result.details.provider).toBe("tavily");
		expect(result.details.results).toHaveLength(2);
		expect(result.details.results[0]).toMatchObject({
			title: "Hello, World!",
			url: "https://example.com/hello",
		});
	});

	it("calls Brave and parses the nested results", async () => {
		routes["/search"] = (req, res) => {
			expect(req.headers["x-subscription-token"]).toBe("brave-key");
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					web: {
						results: [{ title: "Brave hit", url: "https://example.com/b", description: "Snip." }],
					},
				}),
			);
		};

		const result = await search(
			{ BRAVE_API_KEY: "brave-key", BRAVE_BASE_URL: `${baseUrl}/search` },
			{ query: "anything" },
		);
		expect(result.details.provider).toBe("brave");
		expect(result.details.results[0].title).toBe("Brave hit");
	});

	it("calls SearXNG and slices to max_results", async () => {
		routes["/search"] = (_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					results: [
						{ title: "r1", url: "u1", content: "s1" },
						{ title: "r2", url: "u2", content: "s2" },
						{ title: "r3", url: "u3" },
					],
				}),
			);
		};

		const result = await search({ SEARXNG_URL: baseUrl }, { query: "topic", max_results: 2 });
		expect(result.details.provider).toBe("searxng");
		expect(result.details.results).toHaveLength(2);
		expect(result.details.results[0].snippet).toBe("s1");
	});

	it("surfaces provider HTTP errors with the status code", async () => {
		routes["/search"] = (_req, res) => {
			res.statusCode = 401;
			res.end("unauthorized");
		};

		await expect(search({ TAVILY_API_KEY: "bad", TAVILY_BASE_URL: baseUrl }, { query: "x" })).rejects.toThrow(
			/tavily 401/,
		);
	});

	it("returns an empty list with a friendly message when no results", async () => {
		routes["/search"] = (_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ results: [] }));
		};

		const result = await search({ TAVILY_API_KEY: "x", TAVILY_BASE_URL: baseUrl }, { query: "void" });
		expect(result.details.results).toEqual([]);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/No results/);
	});
});
