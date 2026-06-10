import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpOAuthProvider } from "./provider.js";
import { McpOAuthStore } from "./store.js";
import type { ServerCredentials } from "./types.js";

function creds(overrides: Partial<ServerCredentials["tokens"]> = {}): ServerCredentials {
	return {
		client: { client_id: "cid" },
		tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now(), ...overrides },
		metadata: { authorization_endpoint: "https://a/authorize", token_endpoint: "https://a/token" },
		resource: "https://mcp.example.com",
	};
}

describe("McpOAuthProvider", () => {
	let root: string;
	let store: McpOAuthStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mcp-prov-"));
		store = new McpOAuthStore(root);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns no headers when the server has never authorized", async () => {
		const p = new McpOAuthProvider("srv", "https://mcp.example.com", store);
		expect(await p.authHeaders()).toEqual({});
	});

	it("returns a bearer header for a valid stored token", async () => {
		store.set("srv", creds());
		const p = new McpOAuthProvider("srv", "https://mcp.example.com", store);
		expect(await p.authHeaders()).toEqual({ Authorization: "Bearer at" });
	});

	it("refreshes and persists when the access token is expired", async () => {
		store.set("srv", creds({ expires_in: 10 })); // already past the 60s skew
		const fetchImpl = (async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({ access_token: "fresh", expires_in: 3600 }),
				text: async () => "",
			}) as Response) as unknown as typeof fetch;
		const p = new McpOAuthProvider("srv", "https://mcp.example.com", store, { fetchImpl });
		expect(await p.authHeaders()).toEqual({ Authorization: "Bearer fresh" });
		// Persisted, and the prior refresh token carried forward.
		expect(store.get("srv")?.tokens.access_token).toBe("fresh");
		expect(store.get("srv")?.tokens.refresh_token).toBe("rt");
	});

	it("drops the header when a refresh fails, so the request re-401s", async () => {
		store.set("srv", creds({ expires_in: 10 }));
		const fetchImpl = (async () =>
			({
				ok: false,
				status: 400,
				json: async () => ({}),
				text: async () => "bad",
			}) as Response) as unknown as typeof fetch;
		const p = new McpOAuthProvider("srv", "https://mcp.example.com", store, { fetchImpl });
		expect(await p.authHeaders()).toEqual({});
	});

	it("handleUnauthorized refreshes when a refresh token is present", async () => {
		store.set("srv", creds());
		const fetchImpl = (async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({ access_token: "after401", expires_in: 3600 }),
				text: async () => "",
			}) as Response) as unknown as typeof fetch;
		const p = new McpOAuthProvider("srv", "https://mcp.example.com", store, { fetchImpl });
		expect(await p.handleUnauthorized(null)).toBe(true);
		expect(store.get("srv")?.tokens.access_token).toBe("after401");
	});
});
