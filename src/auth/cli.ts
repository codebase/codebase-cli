import { CredentialsStore } from "./credentials.js";
import { type OAuthConfig, refreshAccessToken, revokeToken, runOAuthLogin } from "./flow.js";

const DEFAULT_AUTH_BASE = "https://codebase.design";

/**
 * Resolves the OAuth config the CLI uses against the codebase web app.
 *
 * The endpoint shapes come from the web's source-of-truth in
 * `web/backend/routes/oauth.js` (and were re-confirmed in
 * `docs/oauth-web-alignment-2026-05-08.md`):
 *
 *   • authorizationUrl  → `${base}/login` — the Next.js page that
 *     POSTs PKCE params to /oauth/authorize on the user's behalf and
 *     redirects back to the CLI's localhost callback.
 *   • tokenUrl + refreshUrl → `${base}/api/oauth/token` — single
 *     endpoint, two grant types (`authorization_code` + `refresh_token`).
 *   • revokeUrl → `${base}/api/oauth/revoke`.
 *
 * codebase.design and codebase.foundation both alias to the same Next
 * app; the user-facing brand is .design so it's the default.
 */
export function defaultOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
	const base = (env.CODEBASE_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE).replace(/\/+$/, "");
	return {
		authorizationUrl: `${base}/login`,
		tokenUrl: `${base}/api/oauth/token`,
		refreshUrl: `${base}/api/oauth/token`,
		revokeUrl: `${base}/api/oauth/revoke`,
		clientId: env.CODEBASE_CLIENT_ID ?? "codebase-cli",
		scopes: (env.CODEBASE_SCOPES ?? "inference projects credits").split(/\s+/).filter(Boolean),
	};
}

export interface AuthCliOptions {
	store?: CredentialsStore;
	config?: OAuthConfig;
	stdout?: (msg: string) => void;
	stderr?: (msg: string) => void;
}

/**
 * Dispatch a `codebase auth …` subcommand. Returns the exit code to
 * surface from the parent process.
 *
 * Recognized argv:
 *   auth                  → status
 *   auth status           → status
 *   auth login            → run OAuth browser flow, persist tokens
 *   auth logout           → clear credentials, best-effort server revoke
 *   auth refresh          → force a refresh against the stored refresh token
 *   auth <key>            → save a manual API key (headless / SSH)
 */
export async function runAuthSubcommand(argv: string[], options: AuthCliOptions = {}): Promise<number> {
	const store = options.store ?? new CredentialsStore();
	const config = options.config ?? defaultOAuthConfig();
	const out = options.stdout ?? ((m) => process.stdout.write(`${m}\n`));
	const err = options.stderr ?? ((m) => process.stderr.write(`${m}\n`));

	const subcommand = argv[1] ?? "status";

	try {
		switch (subcommand) {
			case "status":
				return statusCmd(store, out);

			case "login":
				return await loginCmd(store, config, out, err);

			case "logout":
				return await logoutCmd(store, config, out);

			case "refresh":
				return await refreshCmd(store, config, out, err);

			default: {
				if (subcommand.startsWith("-")) {
					err(`unknown flag: ${subcommand}`);
					return 2;
				}
				// Treat as a manual API key
				return manualKeyCmd(store, subcommand, out);
			}
		}
	} catch (e) {
		err(e instanceof Error ? e.message : String(e));
		return 1;
	}
}

function statusCmd(store: CredentialsStore, out: (m: string) => void): number {
	const creds = store.load();
	if (!creds) {
		out("not signed in");
		out("run: codebase auth login");
		return 0;
	}
	const expiry = creds.expiresAt
		? `expires ${new Date(creds.expiresAt).toISOString()}${store.isExpired(creds) ? " (expired)" : ""}`
		: "no expiry";
	out(`signed in via ${creds.source}`);
	if (creds.email) out(`  email:  ${creds.email}`);
	if (creds.userId) out(`  userId: ${creds.userId}`);
	out(`  scopes: ${creds.scopes.join(" ")}`);
	out(`  ${expiry}`);
	out(`  file:   ${store.filePath} (mode ${(store.mode() ?? 0).toString(8)})`);
	return 0;
}

async function loginCmd(
	store: CredentialsStore,
	config: OAuthConfig,
	out: (m: string) => void,
	err: (m: string) => void,
): Promise<number> {
	try {
		const creds = await runOAuthLogin(config, {
			onManualUrl: (url) => {
				// Auto-open the browser is the primary path (fired by
				// runOAuthLogin); the URL print below is the fallback for
				// when the browser can't open — headless / SSH / no
				// $DISPLAY. The click-here OSC 8 hyperlink was removed
				// because terminals that don't honor it (or that intercept
				// clicks for selection) made it actively confusing. The
				// URL prints with NO leading indent so terminal
				// select-copy doesn't pick up padding spaces.
				out("Opening your browser. If it didn't open, copy this URL:");
				out("");
				out(url);
				out("");
				// SSH callers need to reach the localhost callback on this box.
				// Print the port-forward command preemptively so a remote login
				// just works — they paste both commands and are done.
				if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
					const port = new URL(url).searchParams.get("redirect_uri")?.match(/:(\d+)\//)?.[1];
					if (port) {
						out("Detected SSH session. From your laptop, forward the callback port first:");
						out("");
						out(`  ssh -L ${port}:127.0.0.1:${port} <user>@<host>`);
						out("");
					}
				}
				out("Waiting for sign-in…");
			},
		});
		store.save(creds);
		out("");
		out(`signed in${creds.email ? ` as ${creds.email}` : ""}.`);
		return 0;
	} catch (e) {
		err(`login failed: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

async function logoutCmd(store: CredentialsStore, config: OAuthConfig, out: (m: string) => void): Promise<number> {
	const creds = store.load();
	if (creds && creds.source === "codebase") {
		await revokeToken(config, creds.accessToken);
	}
	const removed = store.clear();
	out(removed ? "signed out." : "no credentials to remove.");
	return 0;
}

async function refreshCmd(
	store: CredentialsStore,
	config: OAuthConfig,
	out: (m: string) => void,
	err: (m: string) => void,
): Promise<number> {
	const creds = store.load();
	if (!creds) {
		err("not signed in");
		return 1;
	}
	if (!creds.refreshToken) {
		err("no refresh token saved (manual API keys can't be refreshed)");
		return 1;
	}
	try {
		const next = await refreshAccessToken(config, creds.refreshToken);
		store.save({
			...next,
			email: next.email ?? creds.email,
			userId: next.userId ?? creds.userId,
		});
		out("refreshed");
		return 0;
	} catch (e) {
		err(`refresh failed: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

function manualKeyCmd(store: CredentialsStore, key: string, out: (m: string) => void): number {
	if (!key || key.length < 16) {
		throw new Error("API key looks too short — paste the full token from the dashboard.");
	}
	store.save({
		accessToken: key,
		scopes: ["inference"],
		source: "manual",
	});
	out("API key saved.");
	return 0;
}
