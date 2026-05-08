import { type AddressInfo, createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { awaitCallback, buildAuthorizationUrl, exchangeCode, type OAuthConfig, refreshAccessToken } from "./flow.js";

const baseConfig: OAuthConfig = {
	authorizationUrl: "https://example.com/auth",
	tokenUrl: "https://example.com/token",
	refreshUrl: "https://example.com/refresh",
	clientId: "codebase-cli",
	scopes: ["inference", "credits"],
};

describe("buildAuthorizationUrl", () => {
	it("URL-encodes scope with embedded spaces", () => {
		const url = buildAuthorizationUrl(baseConfig, {
			codeChallenge: "abc",
			state: "s",
			redirectUri: "http://localhost:1234/callback",
		});
		expect(url).toContain("scope=inference+credits");
	});

	it("includes the canonical PKCE params", () => {
		const url = buildAuthorizationUrl(baseConfig, {
			codeChallenge: "challenge",
			state: "state",
			redirectUri: "http://localhost:1234/callback",
		});
		expect(url).toContain("code_challenge=challenge");
		expect(url).toContain("code_challenge_method=S256");
		expect(url).toContain("state=state");
		expect(url).toContain("response_type=code");
	});

	it("URL-encodes the redirect_uri", () => {
		const url = buildAuthorizationUrl(baseConfig, {
			codeChallenge: "c",
			state: "s",
			redirectUri: "http://localhost:1234/callback?x=y",
		});
		expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback%3Fx%3Dy");
	});
});

describe("awaitCallback", () => {
	let server: Server;
	let port: number;

	beforeEach(async () => {
		server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(() => {
		server.close();
	});

	it("resolves on a valid /callback with matching state", async () => {
		const promise = awaitCallback(server, "S1", 5000);
		await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=S1`);
		await expect(promise).resolves.toEqual({ code: "ABC", state: "S1" });
	});

	it("rejects on state mismatch", async () => {
		const promise = awaitCallback(server, "GOOD", 5000).catch((e) => e);
		await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=BAD`);
		const err = await promise;
		expect((err as Error).message).toMatch(/state mismatch/);
	});

	it("rejects when /callback is hit without a code", async () => {
		const promise = awaitCallback(server, "S", 5000).catch((e) => e);
		await fetch(`http://127.0.0.1:${port}/callback?state=S`);
		const err = await promise;
		expect((err as Error).message).toMatch(/missing code/);
	});

	it("rejects when the provider returns an error param", async () => {
		const promise = awaitCallback(server, "S", 5000).catch((e) => e);
		await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=user+cancelled&state=S`);
		const err = await promise;
		expect((err as Error).message).toMatch(/access_denied/);
	});

	it("returns 404 for unknown paths and keeps waiting", async () => {
		const promise = awaitCallback(server, "S", 2000);
		const stray = await fetch(`http://127.0.0.1:${port}/random`);
		expect(stray.status).toBe(404);
		// Still waiting for the real callback
		await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=S`);
		await expect(promise).resolves.toMatchObject({ code: "ABC" });
	});

	it("rejects on timeout", async () => {
		const promise = awaitCallback(server, "S", 100);
		await expect(promise).rejects.toThrow(/timed out/);
	});
});

// ─── exchangeCode + refreshAccessToken via mock token server ──

type RouteHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

let tokenServer: Server;
let tokenBaseUrl: string;
const tokenRoutes: Record<string, RouteHandler> = {};

beforeAll(async () => {
	tokenServer = createServer((req, res) => {
		const handler = tokenRoutes[req.url?.split("?")[0] ?? "/"];
		if (handler) handler(req, res);
		else {
			res.statusCode = 404;
			res.end();
		}
	});
	await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
	const port = (tokenServer.address() as AddressInfo).port;
	tokenBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
});

describe("exchangeCode", () => {
	it("posts the form-encoded body and returns Credentials", async () => {
		tokenRoutes["/token"] = (req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const params = new URLSearchParams(body);
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("code")).toBe("CODE");
				expect(params.get("code_verifier")).toBe("VERIFIER");
				expect(params.get("redirect_uri")).toBe("http://localhost/cb");
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						access_token: "tok",
						refresh_token: "ref",
						expires_in: 3600,
						scope: "inference credits",
						user: { id: "u1", email: "e@x.com" },
					}),
				);
			});
		};

		const creds = await exchangeCode(
			{ ...baseConfig, tokenUrl: `${tokenBaseUrl}/token` },
			{ code: "CODE", codeVerifier: "VERIFIER", redirectUri: "http://localhost/cb" },
		);
		expect(creds.accessToken).toBe("tok");
		expect(creds.refreshToken).toBe("ref");
		expect(creds.scopes).toEqual(["inference", "credits"]);
		expect(creds.email).toBe("e@x.com");
		expect(creds.expiresAt).toBeGreaterThan(Date.now());
	});

	it("throws on non-2xx with provider message attached", async () => {
		tokenRoutes["/token"] = (_req, res) => {
			res.statusCode = 400;
			res.end("invalid_grant");
		};
		await expect(
			exchangeCode(
				{ ...baseConfig, tokenUrl: `${tokenBaseUrl}/token` },
				{ code: "x", codeVerifier: "x", redirectUri: "x" },
			),
		).rejects.toThrow(/400.*invalid_grant/);
	});
});

describe("refreshAccessToken", () => {
	it("posts the refresh body and returns the new credentials", async () => {
		tokenRoutes["/refresh"] = (req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const params = new URLSearchParams(body);
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("OLD_REFRESH");
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ access_token: "NEW_TOK", expires_in: 600 }));
			});
		};
		const creds = await refreshAccessToken({ ...baseConfig, refreshUrl: `${tokenBaseUrl}/refresh` }, "OLD_REFRESH");
		expect(creds.accessToken).toBe("NEW_TOK");
	});
});
