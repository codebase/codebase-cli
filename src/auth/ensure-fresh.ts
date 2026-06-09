import { defaultOAuthConfig } from "./cli.js";
import { CredentialsStore } from "./credentials.js";
import { TokenManager } from "./token-manager.js";

/**
 * Cold-start credential refresh. Call once before `createAgent` so a
 * proxy session whose access token expired between launches gets
 * silently rotated using the long-lived refresh token, instead of
 * bouncing the user back to the login wizard.
 *
 * Why this exists: `resolveConfig` runs synchronously and bails as
 * soon as it sees an expired access token — but `TokenManager` (which
 * knows how to refresh) only gets constructed AFTER `createAgent`
 * succeeds. That's a chicken/egg the previous code didn't notice
 * because a fresh login + fresh process never tripped it.
 *
 * Safe to call on every launch. No-ops when:
 *   - no credentials exist (wizard handles it)
 *   - source isn't "codebase" (BYOK / env-key sessions don't refresh)
 *   - access token is still good (TokenManager's preemptive window)
 *
 * Errors are NOT thrown: a network blip during cold start should fall
 * through to `resolveConfig`, which will produce the existing
 * "please run `codebase auth login`" path. The user sees one error,
 * not two layered ones.
 */
export async function ensureFreshCredentials(): Promise<void> {
	const store = new CredentialsStore();
	const creds = store.load();
	if (!creds) return;
	if (creds.source !== "codebase") return;
	if (!creds.refreshToken) return;
	if (!store.isExpired(creds)) return;

	const manager = new TokenManager({ store, oauthConfig: defaultOAuthConfig() });
	try {
		await manager.getAccessToken();
	} catch {
		// Refresh failed — leave the stale creds in place so resolveConfig
		// produces the canonical "sign in again" message instead of a
		// noisy network-error trace. The user retries via the wizard.
	}
}
