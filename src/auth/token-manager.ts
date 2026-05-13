import type { Credentials, CredentialsStore } from "./credentials.js";
import { type OAuthConfig, refreshAccessToken } from "./flow.js";

export interface TokenManagerOptions {
	store: CredentialsStore;
	oauthConfig: OAuthConfig;
	/**
	 * Refresh when the access token's remaining lifetime falls below this
	 * many milliseconds. Default 60s — generous enough to ride out clock
	 * skew + a slow refresh round-trip without ever sending an expired
	 * token over the wire.
	 */
	refreshSkewMs?: number;
}

/**
 * Read-through, refresh-aware accessor for the OAuth access token.
 *
 * Pi-mono's `getApiKey` runs on every API call, so we have to be fast in
 * the common case (token still valid). Slow path: refresh + persist before
 * returning the new token. A single in-flight promise (`pending`) prevents
 * a burst of concurrent calls from firing parallel refreshes at the same
 * moment — they all await the one refresh that's already running.
 */
export class TokenManager {
	private readonly store: CredentialsStore;
	private readonly oauthConfig: OAuthConfig;
	private readonly refreshSkewMs: number;
	private pending: Promise<string> | null = null;

	constructor(options: TokenManagerOptions) {
		this.store = options.store;
		this.oauthConfig = options.oauthConfig;
		this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
	}

	/**
	 * Return a valid access token, refreshing if the stored one is within
	 * `refreshSkewMs` of expiry. Throws when no credentials exist or when
	 * a refresh fails (network or expired refresh token); the caller turns
	 * that into a user-facing "please run `codebase auth login`" message.
	 */
	async getAccessToken(): Promise<string> {
		const creds = this.store.load();
		if (!creds) throw new Error("not signed in — run `codebase auth login`");
		if (!this.needsRefresh(creds)) return creds.accessToken;
		if (!creds.refreshToken) {
			throw new Error("access token expired and no refresh token saved — run `codebase auth login`");
		}
		return this.refresh(creds.refreshToken);
	}

	private needsRefresh(creds: Credentials): boolean {
		if (!creds.expiresAt) return false;
		return creds.expiresAt - this.refreshSkewMs <= Date.now();
	}

	private refresh(refreshToken: string): Promise<string> {
		if (this.pending) return this.pending;
		this.pending = (async () => {
			try {
				const next = await refreshAccessToken(this.oauthConfig, refreshToken);
				// Preserve fields the refresh response doesn't echo back (source,
				// email, userId) so they survive every rotation. The refresh
				// response is authoritative for tokens + expiry; we layer the
				// stable metadata back on top.
				const existing = this.store.load();
				this.store.save({
					accessToken: next.accessToken,
					refreshToken: next.refreshToken ?? existing?.refreshToken ?? refreshToken,
					expiresAt: next.expiresAt,
					scopes: next.scopes,
					source: existing?.source ?? next.source,
					userId: existing?.userId ?? next.userId,
					email: existing?.email ?? next.email,
					provider: existing?.provider ?? next.provider,
				});
				return next.accessToken;
			} finally {
				this.pending = null;
			}
		})();
		return this.pending;
	}
}
