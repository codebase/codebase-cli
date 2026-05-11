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
	const title = ok ? "Signed in" : "Sign-in failed";
	const accent = ok ? "#22c55e" : "#ef4444";
	const subtitle = ok ? "You can close this tab." : "Return to your terminal for details.";
	// Inline SVG logo + minimal CSS. No external deps so the page renders
	// before any network even on the CLI's localhost-only callback host.
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codebase · ${title}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
	background: #0a0a0b;
	color: #f1f1f3;
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
}
@media (prefers-color-scheme: light) {
	body { background: #fafafa; color: #0a0a0b; }
	.card { background: #fff; border-color: #e5e5ea; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06); }
	.subtitle { color: #6b6b73; }
	.hint { color: #6b6b73; }
}
.card {
	max-width: 440px;
	width: 100%;
	padding: 40px 36px 32px;
	border: 1px solid #1f1f23;
	border-radius: 16px;
	background: #131316;
	box-shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.4);
	text-align: center;
}
.logo {
	width: 64px;
	height: 64px;
	margin: 0 auto 24px;
	display: block;
}
.logo rect { fill: currentColor; }
.icon {
	width: 48px;
	height: 48px;
	margin: 0 auto 12px;
	border-radius: 999px;
	background: ${accent}22;
	color: ${accent};
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 28px;
	font-weight: 600;
}
h1 {
	font-size: 22px;
	font-weight: 600;
	margin: 0 0 4px;
	letter-spacing: -0.01em;
}
.subtitle {
	color: #a3a3ab;
	font-size: 14px;
	margin: 0 0 24px;
}
.message {
	background: rgba(255,255,255,0.04);
	border: 1px solid rgba(255,255,255,0.06);
	padding: 12px 14px;
	border-radius: 8px;
	font-size: 13px;
	text-align: left;
	white-space: pre-wrap;
}
@media (prefers-color-scheme: light) {
	.message { background: #f5f5f7; border-color: #e5e5ea; }
}
.hint {
	margin-top: 18px;
	font-size: 12px;
	color: #6b6b73;
}
.brand {
	font-size: 12px;
	color: #6b6b73;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	margin-bottom: 8px;
}
</style>
</head>
<body>
<div class="card">
	<svg class="logo" viewBox="7 6 6 7" shape-rendering="crispEdges" aria-hidden="true">
		<rect width="1" height="1" x="9" y="7" /><rect width="1" height="1" x="10" y="7" /><rect width="1" height="1" x="11" y="7" />
		<rect width="1" height="1" x="8" y="8" /><rect width="1" height="1" x="8" y="9" /><rect width="1" height="1" x="8" y="10" />
		<rect width="1" height="1" x="9" y="11" /><rect width="1" height="1" x="10" y="11" /><rect width="1" height="1" x="11" y="11" />
	</svg>
	<div class="brand">codebase</div>
	<div class="icon" aria-hidden="true">${ok ? "✓" : "!"}</div>
	<h1>${title}</h1>
	<p class="subtitle">${subtitle}</p>
	<div class="message">${escapeHtml(message)}</div>
	<p class="hint">${ok ? "Your terminal is signed in via codebase.design." : "Try <code>codebase auth login</code> again, or check your terminal for the error."}</p>
</div>
</body>
</html>`;
	res.statusCode = ok ? 200 : 400;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(html);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Token endpoints on codebase.design's web app expect JSON bodies —
 * `app.js` only mounts `express.json()`, no `express.urlencoded()`.
 * OAuth 2.0 RFC 6749 §4.1.3 says token endpoints MUST accept
 * form-urlencoded; the web app is non-standard there but it's easier
 * to send JSON from the CLI than to upstream a middleware change.
 */
export async function exchangeCode(
	config: OAuthConfig,
	params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<Credentials> {
	const res = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: config.clientId,
			code: params.code,
			code_verifier: params.codeVerifier,
			redirect_uri: params.redirectUri,
		}),
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
	const res = await fetch(config.refreshUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: config.clientId,
			refresh_token: refreshToken,
		}),
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
	try {
		await fetch(config.revokeUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: accessToken, client_id: config.clientId }),
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

	if (isHeadlessSession()) {
		opts.onManualUrl?.(authUrl, "headless session detected — open the URL manually in your browser");
	} else {
		try {
			await openBrowserFn(authUrl);
		} catch (err) {
			// DON'T tear down the server: the user can still complete
			// sign-in by opening the URL themselves. Surface the URL via
			// onManualUrl and continue waiting for the callback.
			opts.onManualUrl?.(authUrl, `auto-open failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const { code } = await callbackPromise;
	return exchangeCode(config, { code, codeVerifier: verifier, redirectUri });
}

/**
 * Heuristic: is this process running somewhere that obviously can't
 * launch a GUI browser? We bail out of the auto-open attempt instead
 * of letting xdg-open ENOENT or `open` hang on a headless macOS box.
 */
function isHeadlessSession(): boolean {
	const env = process.env;
	if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
	if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
	return false;
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
