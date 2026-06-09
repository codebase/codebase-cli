import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as lockfile from "proper-lockfile";
import type { Credentials, CredentialsStore } from "./credentials.js";
import { type OAuthConfig, refreshAccessToken } from "./flow.js";

export interface TokenManagerOptions {
	store: CredentialsStore;
	oauthConfig: OAuthConfig;
	/**
	 * Refresh when the access token's remaining lifetime falls below this
	 * many milliseconds. Default 5 minutes — wide enough to absorb clock
	 * skew, slow refresh round-trips, and a request that starts just under
	 * the wire so it never travels with an already-expired token.
	 */
	refreshSkewMs?: number;
	/**
	 * Max time to wait acquiring the cross-process refresh lock before
	 * giving up. If another `codebase` process is mid-refresh we wait;
	 * if the lock is wedged (stale, crashed peer) we bail rather than
	 * hang the user's request.
	 */
	lockTimeoutMs?: number;
}

/**
 * Read-through, refresh-aware accessor for the OAuth access token.
 *
 * Two coordination layers:
 *   1. In-memory single-flight (`pending`) — multiple awaits within ONE
 *      process collapse into one refresh round-trip.
 *   2. Filesystem lockfile on the credentials directory — multiple
 *      `codebase` processes on the same machine coordinate so only one
 *      refreshes at a time. The others wait, re-read the rotated token,
 *      and skip their own refresh. Necessary because refresh tokens are
 *      often one-time-use: two parallel refreshes burn the shared refresh
 *      token and one process gets logged out.
 *
 * Pi-mono's `getApiKey` runs on every API call, so the cached-token fast
 * path stays branch-free; the slow path only fires near expiry.
 */
export class TokenManager {
	private readonly store: CredentialsStore;
	private readonly oauthConfig: OAuthConfig;
	private readonly refreshSkewMs: number;
	private readonly lockTimeoutMs: number;
	private pending: Promise<string> | null = null;

	constructor(options: TokenManagerOptions) {
		this.store = options.store;
		this.oauthConfig = options.oauthConfig;
		this.refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
		this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
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
		return this.refresh();
	}

	/**
	 * "Should I refresh proactively?" — true when expiry is within
	 * `refreshSkewMs` (default 5 min) of now. Wider than
	 * `CredentialsStore.isExpired`'s 60s wire-dead check on purpose:
	 * refreshing 5 min early absorbs clock skew, slow refresh round
	 * trips, and a request that starts just under the wire so the
	 * outbound API call never carries an already-dead token.
	 *
	 * Pair: `CredentialsStore.isExpired` is "is this dead RIGHT NOW";
	 * this is "should I rotate it soon." Both are checks against the
	 * same `expiresAt` field with different skew windows.
	 */
	private needsRefresh(creds: Credentials): boolean {
		if (!creds.expiresAt) return false;
		return creds.expiresAt - this.refreshSkewMs <= Date.now();
	}

	private refresh(): Promise<string> {
		if (this.pending) return this.pending;
		this.pending = (async () => {
			try {
				return await this.refreshWithLock();
			} finally {
				this.pending = null;
			}
		})();
		return this.pending;
	}

	/**
	 * Acquire a cross-process lock, then re-check (another process may have
	 * already refreshed by the time we get the lock), then refresh + save.
	 * The double-check is the whole point of taking the lock — it converts
	 * N parallel refreshes into 1 refresh + N-1 reads of the fresh token.
	 */
	private async refreshWithLock(): Promise<string> {
		const lockDir = dirname(this.store.filePath);
		mkdirSync(lockDir, { recursive: true });
		const release = await lockfile.lock(lockDir, {
			retries: {
				retries: Math.max(1, Math.ceil(this.lockTimeoutMs / 500)),
				minTimeout: 250,
				maxTimeout: 1000,
				factor: 1.5,
				randomize: true,
			},
			// 30s — stale-lock window. Survives a normal refresh; releases
			// quickly enough that a crashed peer doesn't wedge us for long.
			stale: 30_000,
		});
		try {
			const reread = this.store.load();
			if (reread && !this.needsRefresh(reread)) return reread.accessToken;
			if (!reread?.refreshToken) {
				throw new Error("access token expired and no refresh token saved — run `codebase auth login`");
			}
			const next = await refreshAccessToken(this.oauthConfig, reread.refreshToken);
			// Preserve fields the refresh response doesn't echo back (source,
			// email, userId) so they survive every rotation. The refresh
			// response is authoritative for tokens + expiry; we layer the
			// stable metadata back on top.
			this.store.save({
				accessToken: next.accessToken,
				refreshToken: next.refreshToken ?? reread.refreshToken,
				expiresAt: next.expiresAt,
				scopes: next.scopes,
				source: reread.source ?? next.source,
				userId: reread.userId ?? next.userId,
				email: reread.email ?? next.email,
				provider: reread.provider ?? next.provider,
			});
			return next.accessToken;
		} finally {
			await release().catch(() => {
				// Release can fail if the lock was stale-released by another
				// process while we held it. The credentials are already saved
				// at that point — there's nothing useful to do here.
			});
		}
	}
}
