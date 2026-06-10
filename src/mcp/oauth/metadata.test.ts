import { describe, expect, it } from "vitest";
import { discoverAuthServer, discoverProtectedResource, parseWwwAuthenticate } from "./metadata.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("parseWwwAuthenticate", () => {
	it("extracts the resource_metadata URL", () => {
		const h =
			'Bearer error="invalid_token", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"';
		expect(parseWwwAuthenticate(h)).toBe("https://api.example.com/.well-known/oauth-protected-resource");
	});

	it("returns undefined when absent or null", () => {
		expect(parseWwwAuthenticate(null)).toBeUndefined();
		expect(parseWwwAuthenticate("Bearer realm=x")).toBeUndefined();
	});
});

describe("discoverProtectedResource", () => {
	it("uses the advertised URL when given", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
		}) as unknown as typeof fetch;
		const prm = await discoverProtectedResource(
			"https://mcp.example.com/sse",
			"https://meta.example.com/prm",
			fetchImpl,
		);
		expect(calls).toEqual(["https://meta.example.com/prm"]);
		expect(prm.authorization_servers).toEqual(["https://auth.example.com"]);
	});

	it("falls back to the well-known path on the server origin", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
		}) as unknown as typeof fetch;
		await discoverProtectedResource("https://mcp.example.com/sse", undefined, fetchImpl);
		expect(calls).toEqual(["https://mcp.example.com/.well-known/oauth-protected-resource"]);
	});
});

describe("discoverAuthServer", () => {
	it("returns OAuth metadata from the first well-known path", async () => {
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("oauth-authorization-server")) {
				return jsonResponse({
					authorization_endpoint: "https://auth.example.com/authorize",
					token_endpoint: "https://auth.example.com/token",
				});
			}
			return jsonResponse({}, false);
		}) as unknown as typeof fetch;
		const meta = await discoverAuthServer("https://auth.example.com", fetchImpl);
		expect(meta.token_endpoint).toBe("https://auth.example.com/token");
	});

	it("falls back to OIDC discovery", async () => {
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("openid-configuration")) {
				return jsonResponse({
					authorization_endpoint: "https://auth.example.com/authorize",
					token_endpoint: "https://auth.example.com/token",
				});
			}
			return jsonResponse({}, false);
		}) as unknown as typeof fetch;
		const meta = await discoverAuthServer("https://auth.example.com", fetchImpl);
		expect(meta.authorization_endpoint).toBe("https://auth.example.com/authorize");
	});

	it("throws when neither path yields endpoints", async () => {
		const fetchImpl = (async () => jsonResponse({}, false)) as unknown as typeof fetch;
		await expect(discoverAuthServer("https://auth.example.com", fetchImpl)).rejects.toThrow(/could not discover/);
	});
});
