import { exec } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Credentials } from "./credentials.js";
import { constantTimeEquals, generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";

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

export interface AuthorizationUrlParams {
	codeChallenge: string;
	state: string;
	redirectUri: string;
}

/**
 * Build the URL we open in the user's browser. Every parameter is
 * URL-encoded — a space in the scope used to break the redirect in
 * the Go v1 (commit ac1dd56), and we don't want that bug to come
 * back unnoticed.
 */
export function buildAuthorizationUrl(config: OAuthConfig, params: AuthorizationUrlParams): string {
	const url = new URL(config.authorizationUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", config.scopes.join(" "));
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

export interface CallbackResult {
	code: string;
	state: string;
}

/**
 * Spin a localhost HTTP server, listen for one /callback hit, return
 * the code+state. Validates the returned state against the supplied
 * value to defend against CSRF; treats anything else as an error.
 *
 * Resolves with { code, state } on success. Rejects on timeout, state
 * mismatch, or upstream error param.
 */
export function awaitCallback(server: Server, expectedState: string, timeoutMs: number): Promise<CallbackResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const safeResolve = (value: CallbackResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const safeReject = (err: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		};

		const timer = setTimeout(() => {
			server.close();
			safeReject(new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);

		server.on("request", (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== "/callback") {
				res.statusCode = 404;
				res.end("Not Found. The codebase OAuth callback expects /callback.");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const desc = url.searchParams.get("error_description") ?? "";
				renderResponse(res, false, `Sign-in failed: ${error}${desc ? ` — ${desc}` : ""}`);
				server.close();
				safeReject(new Error(`OAuth provider returned error: ${error}${desc ? ` — ${desc}` : ""}`));
				return;
			}
			const code = url.searchParams.get("code") ?? "";
			const state = url.searchParams.get("state") ?? "";
			if (!code) {
				renderResponse(res, false, "Sign-in failed: provider did not return a code.");
				server.close();
				safeReject(new Error("OAuth callback missing code parameter"));
				return;
			}
			if (!constantTimeEquals(state, expectedState)) {
				renderResponse(res, false, "Sign-in failed: state mismatch (possible CSRF).");
				server.close();
				safeReject(new Error("OAuth callback state mismatch"));
				return;
			}

			renderResponse(res, true, "Signed in. You can close this tab.");
			server.close();
			safeResolve({ code, state });
		});

		server.on("error", (err) => {
			safeReject(err);
		});
	});
}

function renderResponse(res: ServerResponse, ok: boolean, message: string): void {
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>codebase</title></head>
<body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto;">
<h1>${ok ? "✓" : "✗"} codebase</h1>
<p>${message}</p>
</body></html>`;
	res.statusCode = ok ? 200 : 400;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end(html);
}

export async function exchangeCode(
	config: OAuthConfig,
	params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<Credentials> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: config.clientId,
		code: params.code,
		code_verifier: params.codeVerifier,
		redirect_uri: params.redirectUri,
	});

	const res = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`token exchange failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
		);
	}
	const json = (await res.json()) as TokenResponse;
	return tokenToCredentials(json, config);
}

export async function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<Credentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: config.clientId,
		refresh_token: refreshToken,
	});
	const res = await fetch(config.refreshUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`token refresh failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
	}
	const json = (await res.json()) as TokenResponse;
	return tokenToCredentials(json, config);
}

export async function revokeToken(config: OAuthConfig, accessToken: string): Promise<void> {
	if (!config.revokeUrl) return;
	const body = new URLSearchParams({ token: accessToken, client_id: config.clientId });
	try {
		await fetch(config.revokeUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
	} catch {
		// Best-effort logout — local credentials clear regardless.
	}
}

interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
	user?: { id?: string; email?: string };
}

function tokenToCredentials(token: TokenResponse, config: OAuthConfig): Credentials {
	if (!token.access_token) throw new Error("token response missing access_token");
	const scopes = token.scope ? token.scope.split(/\s+/).filter(Boolean) : config.scopes.slice();
	return {
		version: 1,
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
		scopes,
		userId: token.user?.id,
		email: token.user?.email,
		source: "codebase",
	};
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
export async function runOAuthLogin(
	config: OAuthConfig,
	openBrowserFn: (url: string) => Promise<void> = openBrowser,
): Promise<Credentials> {
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

	try {
		await openBrowserFn(authUrl);
	} catch (err) {
		server.close();
		throw new Error(
			`couldn't open browser automatically: ${err instanceof Error ? err.message : String(err)}. ` +
				`Open this URL manually:\n${authUrl}`,
		);
	}

	const { code } = await callbackPromise;
	return exchangeCode(config, { code, codeVerifier: verifier, redirectUri });
}

/** Best-effort browser open. Falls back to printing the URL on platforms we can't detect. */
export async function openBrowser(url: string): Promise<void> {
	const command = browserOpenCommand(url);
	if (!command) {
		throw new Error(`unsupported platform ${process.platform}`);
	}
	await new Promise<void>((resolve, reject) => {
		exec(command, (err) => (err ? reject(err) : resolve()));
	});
}

function browserOpenCommand(url: string): string | null {
	const escaped = url.replace(/"/g, '\\"');
	if (process.platform === "darwin") return `open "${escaped}"`;
	if (process.platform === "win32") return `start "" "${escaped}"`;
	if (process.platform === "linux") return `xdg-open "${escaped}"`;
	return null;
}
