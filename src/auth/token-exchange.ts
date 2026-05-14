import type { Credentials } from "./credentials.js";
import type { OAuthConfig } from "./flow.js";

interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
	user?: { id?: string; email?: string };
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
