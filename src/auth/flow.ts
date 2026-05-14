import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildAuthorizationUrl } from "./authorization-url.js";
import { isHeadlessSession, openBrowser } from "./browser-open.js";
import { awaitCallback } from "./callback-server.js";
import type { Credentials } from "./credentials.js";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";
import { exchangeCode } from "./token-exchange.js";

export { buildAuthorizationUrl } from "./authorization-url.js";
export { openBrowser } from "./browser-open.js";
export { awaitCallback } from "./callback-server.js";
export { exchangeCode, refreshAccessToken, revokeToken } from "./token-exchange.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for the user to complete the browser flow

export interface OAuthConfig {
	/** Where the user is sent in their browser to start the flow. */
	authorizationUrl: string;
	/** POST endpoint that exchanges code+verifier for tokens. */
	tokenUrl: string;
	/** POST endpoint that refreshes an expired access token. */
	refreshUrl: string;
	/** Optional revoke endpoint, called best-effort on logout. */
	revokeUrl?: string;
	/** Stable client identifier the backend uses to identify the CLI. */
	clientId: string;
	/** Scopes to request (`inference projects credits` for codebase.foundation). */
	scopes: string[];
	/** Network call timeout. */
	timeoutMs?: number;
}

/**
 * Run the full browser OAuth flow:
 *   1. PKCE: generate verifier + challenge + state
 *   2. Bind a localhost HTTP server on a random port
 *   3. Open the authorization URL in the user's browser
 *   4. Wait for /callback, validate state
 *   5. Exchange the code for tokens
 *
 * Returns ready-to-save Credentials.
 */
export interface RunOAuthLoginOptions {
	/** Override the browser-open path (tests). */
	openBrowserFn?: (url: string) => Promise<void>;
	/**
	 * Notification that the user must complete sign-in manually —
	 * either because the session is headless (SSH / no DISPLAY) or
	 * because the auto-open command failed. The local callback server
	 * STAYS RUNNING after this fires so the user can paste the URL
	 * into a browser themselves and the flow completes once the
	 * callback hits 127.0.0.1.
	 */
	onManualUrl?: (url: string, reason: string) => void;
}

export async function runOAuthLogin(
	config: OAuthConfig,
	options: RunOAuthLoginOptions | ((url: string) => Promise<void>) = {},
): Promise<Credentials> {
	// Backwards-compat: callers used to pass a bare openBrowserFn.
	const opts: RunOAuthLoginOptions = typeof options === "function" ? { openBrowserFn: options } : options;
	const openBrowserFn = opts.openBrowserFn ?? openBrowser;

	const verifier = generateCodeVerifier();
	const challenge = generateCodeChallenge(verifier);
	const state = generateState();

	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const authUrl = buildAuthorizationUrl(config, { codeChallenge: challenge, state, redirectUri });

	const callbackPromise = awaitCallback(server, state, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	// Always surface the URL to the caller so it's visible even when
	// auto-open succeeds. Browser-open auto-detection is unreliable
	// (xdg-open hangs on some boxes, `open` on macOS silently no-ops in
	// some shells, SSH forwarding makes localhost-callbacks tricky), so
	// the printed URL is the primary UX — auto-open is best-effort gravy.
	const reason = isHeadlessSession() ? "headless session — open the URL manually" : "open this URL in your browser";
	opts.onManualUrl?.(authUrl, reason);

	// Fire-and-forget the browser open. Don't await — xdg-open / `open`
	// can hang indefinitely on some configurations, and we already gave
	// the user the URL above.
	if (!isHeadlessSession()) {
		openBrowserFn(authUrl).catch(() => undefined);
	}

	const { code } = await callbackPromise;
	return exchangeCode(config, { code, codeVerifier: verifier, redirectUri });
}
