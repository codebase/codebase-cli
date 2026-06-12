import { describe, expect, it } from "vitest";
import { formatContextWindow, scanLocalEndpoints } from "./local-llm.js";

type Responder = (url: string, init?: RequestInit) => unknown | null;

/** fetch stub: responder returns a JSON body, or null to simulate connection refused. */
function fakeFetch(responder: Responder): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		const body = responder(url, init);
		if (body === null) throw new Error("ECONNREFUSED");
		return { ok: true, status: 200, json: async () => body } as Response;
	}) as unknown as typeof fetch;
}

describe("scanLocalEndpoints", () => {
	it("returns nothing when no ports answer", async () => {
		const servers = await scanLocalEndpoints(fakeFetch(() => null));
		expect(servers).toEqual([]);
	});

	it("discovers LM Studio and enriches context length from /api/v0/models", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url) => {
				if (url === "http://127.0.0.1:1234/v1/models") {
					return { data: [{ id: "qwen2.5-coder-32b" }, { id: "text-embedding-nomic" }] };
				}
				if (url === "http://127.0.0.1:1234/api/v0/models") {
					return { data: [{ id: "qwen2.5-coder-32b", type: "llm", max_context_length: 32768 }] };
				}
				return null;
			}),
		);
		expect(servers).toHaveLength(1);
		expect(servers[0].label).toBe("LM Studio");
		expect(servers[0].baseUrl).toBe("http://127.0.0.1:1234/v1");
		// The embedding model is filtered out; the chat model carries its ctx.
		expect(servers[0].models).toEqual([{ id: "qwen2.5-coder-32b", contextWindow: 32768 }]);
	});

	it("discovers Ollama and enriches context length via /api/show", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url, init) => {
				if (url === "http://127.0.0.1:11434/v1/models") {
					return { data: [{ id: "llama3.3:70b" }] };
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					const body = JSON.parse(String(init?.body));
					expect(body.model).toBe("llama3.3:70b");
					return { model_info: { "general.architecture": "llama", "llama.context_length": 131072 } };
				}
				return null;
			}),
		);
		expect(servers).toHaveLength(1);
		expect(servers[0].models).toEqual([{ id: "llama3.3:70b", contextWindow: 131072 }]);
	});

	it("reads vLLM's max_model_len straight off /v1/models", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url) => {
				if (url === "http://127.0.0.1:8000/v1/models") {
					return { data: [{ id: "meta-llama/Llama-3.3-70B", max_model_len: 65536 }] };
				}
				return null;
			}),
		);
		expect(servers[0].models[0]).toEqual({ id: "meta-llama/Llama-3.3-70B", contextWindow: 65536 });
	});

	it("reads llama.cpp's meta.n_ctx_train off /v1/models", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url) => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return { data: [{ id: "qwen2.5-7b-instruct-q4", meta: { n_ctx_train: 32768 } }] };
				}
				return null;
			}),
		);
		expect(servers[0].models[0]).toEqual({ id: "qwen2.5-7b-instruct-q4", contextWindow: 32768 });
	});

	it("collects multiple servers at once and skips non-model responses", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url) => {
				if (url === "http://127.0.0.1:1234/v1/models") return { data: [{ id: "local-model" }] };
				if (url === "http://127.0.0.1:11434/v1/models") return { data: [{ id: "llama3.2" }] };
				if (url === "http://127.0.0.1:8080/v1/models") return { whoami: "not-an-llm-server" };
				return null;
			}),
		);
		expect(servers.map((s) => s.label).sort()).toEqual(["LM Studio", "Ollama"]);
	});

	it("drops a server whose only models are embeddings", async () => {
		const servers = await scanLocalEndpoints(
			fakeFetch((url) => {
				if (url === "http://127.0.0.1:1234/v1/models") return { data: [{ id: "nomic-embed-text" }] };
				return null;
			}),
		);
		expect(servers).toEqual([]);
	});
});

describe("formatContextWindow", () => {
	it("renders k for >=1024 and raw below", () => {
		expect(formatContextWindow(131072)).toBe("128k ctx");
		expect(formatContextWindow(32768)).toBe("32k ctx");
		expect(formatContextWindow(512)).toBe("512 ctx");
		expect(formatContextWindow(undefined)).toBeUndefined();
	});
});
