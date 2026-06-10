import { type AuthorizeDeps, authorize } from "./flow.js";
import { discoverAuthServer, discoverProtectedResource, parseWwwAuthenticate } from "./metadata.js";
import { registerClient } from "./register.js";
import { isAccessTokenExpired, type McpOAuthStore } from "./store.js";
import { refreshTokens } from "./token.js";
import type { RegisteredClient } from "./types.js";

/**
 * What the HTTP transport needs from an auth layer: attach credentials to
 * each request, and react to a 401 by (re)authorizing. Kept narrow so the
 * transport stays oblivious to OAuth mechanics.
 */
export interface McpAuthProvider {
	/** Authorization header(s) for the next request, or {} when we have none yet. */
	authHeaders(): Promise<Record<string, string>>;
	/** Handle a 401: refresh or run the full flow. Returns true if the retry should proceed. */
	handleUnauthorized(wwwAuthenticate: string | null): Promise<boolean>;
}

/**
 * Drives OAuth for one remote MCP server. On the first 401 it discovers
 * the authorization server, registers a client if needed, and runs the
 * interactive browser flow; thereafter it attaches the bearer token and
 * silently refreshes it before expiry. All state persists per-server in
 * the McpOAuthStore.
 */
export class McpOAuthProvider implements McpAuthProvider {
	constructor(
		private readonly serverName: string,
		private readonly serverUrl: string,
		private readonly store: McpOAuthStore,
		private readonly deps: AuthorizeDeps = {},
	) {}

	private get fetchImpl(): typeof fetch {
		return this.deps.fetchImpl ?? fetch;
	}

	async authHeaders(): Promise<Record<string, string>> {
		const creds = this.store.get(this.serverName);
		if (!creds) return {};
		let { tokens } = creds;
		if (isAccessTokenExpired(tokens) && tokens.refresh_token) {
			try {
				tokens = await refreshTokens(
					{
						tokenEndpoint: creds.metadata.token_endpoint,
						refreshToken: tokens.refresh_token,
						client: creds.client,
						resource: creds.resource,
					},
					this.fetchImpl,
				);
				this.store.updateTokens(this.serverName, tokens);
			} catch {
				// Refresh failed — drop the header so the request 401s and the
				// full flow re-runs via handleUnauthorized.
				return {};
			}
		}
		return { Authorization: `${tokens.token_type ?? "Bearer"} ${tokens.access_token}` };
	}

	async handleUnauthorized(wwwAuthenticate: string | null): Promise<boolean> {
		// Try a refresh first — cheap, no browser — if we have a refresh token.
		const existing = this.store.get(this.serverName);
		if (existing?.tokens.refresh_token) {
			try {
				const tokens = await refreshTokens(
					{
						tokenEndpoint: existing.metadata.token_endpoint,
						refreshToken: existing.tokens.refresh_token,
						client: existing.client,
						resource: existing.resource,
					},
					this.fetchImpl,
				);
				this.store.updateTokens(this.serverName, tokens);
				return true;
			} catch {
				// Refresh rejected — fall through to a full re-authorization.
			}
		}

		const prm = await discoverProtectedResource(
			this.serverUrl,
			parseWwwAuthenticate(wwwAuthenticate),
			this.fetchImpl,
		);
		const issuer = prm.authorization_servers?.[0] ?? new URL(this.serverUrl).origin;
		const metadata = await discoverAuthServer(issuer, this.fetchImpl);
		const resource = prm.resource ?? canonicalResource(this.serverUrl);
		const storedClient = existing?.client;

		const { tokens, client } = await authorize(
			{
				serverName: this.serverName,
				metadata,
				resource,
				scope: metadata.scopes_supported?.join(" "),
				getClient: (redirectUri) => this.resolveClient(storedClient, metadata.registration_endpoint, redirectUri),
			},
			this.deps,
		);
		this.store.set(this.serverName, { client, tokens, metadata, resource });
		return true;
	}

	private async resolveClient(
		stored: RegisteredClient | undefined,
		registrationEndpoint: string | undefined,
		redirectUri: string,
	): Promise<RegisteredClient> {
		if (stored) return stored;
		if (!registrationEndpoint) {
			throw new Error(
				`MCP server "${this.serverName}" requires OAuth but its authorization server offers no dynamic registration; ` +
					"set a pre-provisioned token via the server's `headers` instead.",
			);
		}
		return registerClient(registrationEndpoint, redirectUri, this.fetchImpl);
	}
}

/** Canonical resource URI (RFC 8707): scheme + host + path, no query/fragment. */
function canonicalResource(serverUrl: string): string {
	const u = new URL(serverUrl);
	return `${u.origin}${u.pathname}`.replace(/\/$/, "");
}
