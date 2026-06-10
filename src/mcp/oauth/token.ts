import type { OAuthTokens, RegisteredClient } from "./types.js";

export interface ExchangeParams {
	tokenEndpoint: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
	client: RegisteredClient;
	/** Canonical resource URI (RFC 8707) — binds the token to this server. */
	resource: string;
}

/** Trade an authorization code + PKCE verifier for tokens. */
export async function exchangeCode(params: ExchangeParams, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: params.redirectUri,
		client_id: params.client.client_id,
		code_verifier: params.codeVerifier,
		resource: params.resource,
	});
	if (params.client.client_secret) body.set("client_secret", params.client.client_secret);
	return postToken(params.tokenEndpoint, body, fetchImpl);
}

export interface RefreshParams {
	tokenEndpoint: string;
	refreshToken: string;
	client: RegisteredClient;
	resource: string;
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshTokens(params: RefreshParams, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: params.refreshToken,
		client_id: params.client.client_id,
		resource: params.resource,
	});
	if (params.client.client_secret) body.set("client_secret", params.client.client_secret);
	const tokens = await postToken(params.tokenEndpoint, body, fetchImpl);
	// Servers may omit a rotated refresh token; keep the prior one so the
	// session survives the next expiry.
	if (!tokens.refresh_token) tokens.refresh_token = params.refreshToken;
	return tokens;
}

async function postToken(endpoint: string, body: URLSearchParams, fetchImpl: typeof fetch): Promise<OAuthTokens> {
	const res = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`token request failed: HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
	}
	const json = (await res.json()) as Omit<OAuthTokens, "obtained_at"> & { access_token?: string };
	if (!json.access_token) throw new Error("token response missing access_token");
	return { ...json, access_token: json.access_token, obtained_at: nowMs() };
}

/** Indirection so tests can hold time still without faking Date globally. */
function nowMs(): number {
	return Date.now();
}
