import type { OAuthConfig } from "./flow.js";

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
