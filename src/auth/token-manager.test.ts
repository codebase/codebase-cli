import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Credentials, CredentialsStore } from "./credentials.js";
import type { OAuthConfig } from "./flow.js";
import { TokenManager } from "./token-manager.js";

const OAUTH: OAuthConfig = {
	authorizationUrl: "https://example.test/login",
	tokenUrl: "https://example.test/token",
	refreshUrl: "https://example.test/refresh",
	revokeUrl: "https://example.test/revoke",
	clientId: "test-client",
	scopes: ["read", "write"],
};

function freshCreds(overrides: Partial<Credentials> = {}): Omit<Credentials, "version"> {
	return {
		accessToken: "access-current",
		refreshToken: "refresh-current",
		expiresAt: Date.now() + 60 * 60 * 1000,
		scopes: ["read", "write"],
		source: "codebase",
		userId: "u-1",
		email: "u@example.test",
		...overrides,
	};
}

describe("TokenManager", () => {
	let dataRoot: string;
	let store: CredentialsStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "tm-test-"));
		store = new CredentialsStore({ dataRoot });
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns the cached access token when not near expiry", async () => {
		store.save(freshCreds());
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(tm.getAccessToken()).resolves.toBe("access-current");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes and persists when the stored token is within the skew window", async () => {
		store.save(freshCreds({ expiresAt: Date.now() + 10_000 })); // 10s left, under 60s skew
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "access-NEW", refresh_token: "refresh-NEW", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await expect(tm.getAccessToken()).resolves.toBe("access-NEW");
		const persisted = store.load();
		expect(persisted?.accessToken).toBe("access-NEW");
		expect(persisted?.refreshToken).toBe("refresh-NEW");
		// Metadata that the refresh endpoint doesn't echo back is preserved.
		expect(persisted?.email).toBe("u@example.test");
		expect(persisted?.source).toBe("codebase");
	});

	it("preserves the existing refresh token when the refresh response omits it", async () => {
		store.save(freshCreds({ expiresAt: Date.now() + 5_000 }));
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "access-NEW", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await tm.getAccessToken();
		expect(store.load()?.refreshToken).toBe("refresh-current");
	});

	it("single-flights concurrent refresh calls into one network round-trip", async () => {
		store.save(freshCreds({ expiresAt: Date.now() + 5_000 }));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve(
								new Response(JSON.stringify({ access_token: "access-NEW", expires_in: 3600 }), {
									status: 200,
									headers: { "Content-Type": "application/json" },
								}),
							),
						20,
					);
				}),
		);
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		const results = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
		expect(results).toEqual(["access-NEW", "access-NEW", "access-NEW"]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("subsequent calls AFTER a refresh resolve hit the cached path again", async () => {
		store.save(freshCreds({ expiresAt: Date.now() + 5_000 }));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "access-NEW", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await tm.getAccessToken();
		// Now the stored token has a fresh 1h lifetime — should not re-refresh.
		await tm.getAccessToken();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("throws a sign-in-needed error when no credentials exist", async () => {
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await expect(tm.getAccessToken()).rejects.toThrow(/codebase auth login/);
	});

	it("throws when the token expired but no refresh token was saved", async () => {
		store.save(freshCreds({ expiresAt: Date.now() + 5_000, refreshToken: undefined }));
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await expect(tm.getAccessToken()).rejects.toThrow(/codebase auth login/);
	});

	it("treats undefined expiresAt as never-expires (no refresh attempted)", async () => {
		store.save(freshCreds({ expiresAt: undefined }));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const tm = new TokenManager({ store, oauthConfig: OAUTH });
		await expect(tm.getAccessToken()).resolves.toBe("access-current");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
