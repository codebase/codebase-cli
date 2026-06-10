/**
 * OAuth 2.1 types for the MCP authorization flow (spec rev 2025-06-18).
 * Remote MCP servers that require auth answer an unauthenticated request
 * with 401 + a WWW-Authenticate header pointing at their protected-
 * resource metadata; from there we discover the authorization server,
 * (optionally) register a client, and run an authorization-code + PKCE
 * flow. Only the fields we actually consume are typed.
 */

/** RFC 9728 protected-resource metadata. */
export interface ProtectedResourceMetadata {
	resource?: string;
	authorization_servers?: string[];
}

/** RFC 8414 / OIDC authorization-server metadata. */
export interface AuthServerMetadata {
	issuer?: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	code_challenge_methods_supported?: string[];
}

/** A client registered via RFC 7591 dynamic registration (or pre-provisioned). */
export interface RegisteredClient {
	client_id: string;
	client_secret?: string;
}

/** Token-endpoint response, plus the wall-clock time we obtained it. */
export interface OAuthTokens {
	access_token: string;
	token_type?: string;
	refresh_token?: string;
	/** Lifetime in seconds, as returned by the server. */
	expires_in?: number;
	scope?: string;
	/** Epoch ms when these tokens were obtained — basis for expiry math. */
	obtained_at: number;
}

/** Everything we persist for one server's OAuth session. */
export interface ServerCredentials {
	client: RegisteredClient;
	tokens: OAuthTokens;
	metadata: AuthServerMetadata;
	/** Canonical resource URI sent as the `resource` param (RFC 8707). */
	resource: string;
}
