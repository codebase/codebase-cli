import { describe, expect, it } from "vitest";
import { registerClient } from "./register.js";
import { exchangeCode, refreshTokens } from "./token.js";

function capture() {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	return {
		calls,
		fetchImpl: ((url: string, init: RequestInit) => {
			calls.push({ url, init });
			return Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }),
				text: async () => "",
			} as Response);
		}) as unknown as typeof fetch,
	};
}

describe("exchangeCode", () => {
	it("posts an authorization_code grant with PKCE verifier + resource", async () => {
		const { calls, fetchImpl } = capture();
		const tokens = await exchangeCode(
			{
				tokenEndpoint: "https://auth.example.com/token",
				code: "abc",
				codeVerifier: "verifier",
				redirectUri: "http://localhost:9999/callback",
				client: { client_id: "cid" },
				resource: "https://mcp.example.com",
			},
			fetchImpl,
		);
		expect(tokens.access_token).toBe("at");
		expect(tokens.obtained_at).toBeGreaterThan(0);
		const body = new URLSearchParams(calls[0].init.body as string);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code_verifier")).toBe("verifier");
		expect(body.get("resource")).toBe("https://mcp.example.com");
		expect(body.get("client_id")).toBe("cid");
	});
});

describe("refreshTokens", () => {
	it("preserves the prior refresh token when the server omits a new one", async () => {
		const fetchImpl = (() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ access_token: "at2", expires_in: 3600 }),
				text: async () => "",
			} as Response)) as unknown as typeof fetch;
		const tokens = await refreshTokens(
			{
				tokenEndpoint: "https://auth.example.com/token",
				refreshToken: "old-rt",
				client: { client_id: "cid" },
				resource: "https://mcp.example.com",
			},
			fetchImpl,
		);
		expect(tokens.access_token).toBe("at2");
		expect(tokens.refresh_token).toBe("old-rt");
	});
});

describe("registerClient", () => {
	it("posts DCR metadata and returns the client_id", async () => {
		const { calls, fetchImpl } = capture();
		const fetch2 = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return {
				ok: true,
				status: 201,
				json: async () => ({ client_id: "generated-cid" }),
				text: async () => "",
			} as Response;
		}) as unknown as typeof fetch;
		const client = await registerClient(
			"https://auth.example.com/register",
			"http://localhost:9999/callback",
			fetch2,
		);
		expect(client.client_id).toBe("generated-cid");
		const sent = JSON.parse(calls[0].init.body as string);
		expect(sent.redirect_uris).toEqual(["http://localhost:9999/callback"]);
		expect(sent.token_endpoint_auth_method).toBe("none");
	});

	it("throws when no client_id comes back", async () => {
		const fetchImpl = (async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "",
			}) as Response) as unknown as typeof fetch;
		await expect(
			registerClient("https://auth.example.com/register", "http://localhost/callback", fetchImpl),
		).rejects.toThrow(/no client_id/);
	});
});
