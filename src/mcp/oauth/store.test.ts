import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAccessTokenExpired, McpOAuthStore } from "./store.js";
import type { ServerCredentials } from "./types.js";

function creds(overrides: Partial<ServerCredentials> = {}): ServerCredentials {
	return {
		client: { client_id: "cid" },
		tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now() },
		metadata: { authorization_endpoint: "https://a/authorize", token_endpoint: "https://a/token" },
		resource: "https://mcp.example.com",
		...overrides,
	};
}

describe("McpOAuthStore", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("round-trips credentials by server name", () => {
		const store = new McpOAuthStore(root);
		expect(store.get("foo")).toBeUndefined();
		store.set("foo", creds());
		expect(store.get("foo")?.tokens.access_token).toBe("at");
	});

	it("writes the file 0600", () => {
		const store = new McpOAuthStore(root);
		store.set("foo", creds());
		expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
	});

	it("updateTokens keeps client + metadata", () => {
		const store = new McpOAuthStore(root);
		store.set("foo", creds());
		store.updateTokens("foo", { access_token: "at2", obtained_at: Date.now() });
		const after = store.get("foo");
		expect(after?.tokens.access_token).toBe("at2");
		expect(after?.client.client_id).toBe("cid");
	});

	it("delete removes one server, leaves others", () => {
		const store = new McpOAuthStore(root);
		store.set("foo", creds());
		store.set("bar", creds());
		store.delete("foo");
		expect(store.get("foo")).toBeUndefined();
		expect(store.get("bar")).toBeDefined();
	});

	it("survives a corrupt file by starting clean", () => {
		const store = new McpOAuthStore(root);
		store.set("foo", creds());
		writeFileSync(store.filePath, "{ garbage", "utf8");
		expect(store.get("foo")).toBeUndefined();
	});
});

describe("isAccessTokenExpired", () => {
	it("is false within the lifetime", () => {
		expect(isAccessTokenExpired({ access_token: "x", expires_in: 3600, obtained_at: Date.now() })).toBe(false);
	});
	it("is true past expiry minus skew", () => {
		expect(isAccessTokenExpired({ access_token: "x", expires_in: 30, obtained_at: Date.now() })).toBe(true);
	});
	it("treats missing expires_in as non-expiring", () => {
		expect(isAccessTokenExpired({ access_token: "x", obtained_at: 0 })).toBe(false);
	});
});
