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
	const stopReading = beginPasteFallbackReader();
	try {
		const creds = await runOAuthLogin(config, {
			onManualUrl: (url) => {
				// Auto-open the browser is the primary path (fired by
				// runOAuthLogin); the URL print below is the fallback for
				// when the browser can't open — headless / SSH / no
				// $DISPLAY. URL prints with NO leading indent so terminal
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
				out("");
				out("Redirect failed? Paste the http://127.0.0.1/callback?... URL here and press Enter.");
			},
			onPasteFallback: (submit) => {
				stopReading.attachSubmit((line) => {
					const result = submit(line);
					if (result.ok) {
						out("Got the code — finishing sign-in…");
					} else {
						err(result.error);
					}
				});
			},
		});
		store.save(creds);
		out("");
		out(`signed in${creds.email ? ` as ${creds.email}` : ""}.`);
		return 0;
	} catch (e) {
		err(`login failed: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	} finally {
		stopReading.stop();
	}
}

/**
 * Read lines from stdin and forward each to whatever paste handler is
 * later attached via attachSubmit(). Lines submitted before the handler
 * is set are dropped — flow.ts wires the handler synchronously, so the
 * window is microseconds in practice, but the guard means a fast paster
 * isn't met with a crash.
 *
 * Returns { stop, attachSubmit }. stop() restores stdin to its prior
 * mode so the parent shell behaves normally after `auth login` returns.
 */
function beginPasteFallbackReader(): {
	stop: () => void;
	attachSubmit: (handler: (line: string) => void) => void;
} {
	let buffer = "";
	let handler: ((line: string) => void) | undefined;
	const onData = (chunk: Buffer | string): void => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		buffer += text;
		// Submit each complete line; keep the trailing partial in the buffer
		// for the next chunk. \r\n and \r both count as line breaks since
		// terminals on different OSes split paste differently.
		let idx = buffer.search(/\r\n|\r|\n/);
		while (idx >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + (buffer.slice(idx, idx + 2) === "\r\n" ? 2 : 1));
			if (line.trim()) handler?.(line);
			idx = buffer.search(/\r\n|\r|\n/);
		}
	};
	process.stdin.setEncoding("utf8");
	process.stdin.resume();
	process.stdin.on("data", onData);
	return {
		stop: () => {
			process.stdin.off("data", onData);
			process.stdin.pause();
		},
		attachSubmit: (h) => {
			handler = h;
		},
	};
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
