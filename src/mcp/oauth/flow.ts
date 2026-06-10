import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isHeadlessSession, openBrowser } from "../../auth/browser-open.js";
import { awaitCallback } from "../../auth/callback-server.js";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "../../auth/pkce.js";
import { exchangeCode } from "./token.js";
import type { AuthServerMetadata, OAuthTokens, RegisteredClient } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthorizeDeps {
	/** Override browser-open (tests / headless). */
	open?: (url: string) => Promise<void>;
	/** Surface the authorization URL to the user (printed or shown in-app). */
	onAuthUrl?: (url: string, serverName: string) => void;
	/** How long to wait for the user to finish in the browser. */
	timeoutMs?: number;
	/** Override fetch (tests). */
	fetchImpl?: typeof fetch;
}

export interface AuthorizeRequest {
	serverName: string;
	metadata: AuthServerMetadata;
	resource: string;
	scope?: string;
	/**
	 * Resolve the OAuth client once the loopback redirect URI is known.
	 * Lets the caller register a fresh client (RFC 7591) with the exact
	 * redirect URI, or return a previously-stored one.
	 */
	getClient: (redirectUri: string) => Promise<RegisteredClient>;
}

/**
 * Run the interactive authorization-code + PKCE flow against a remote
 * MCP server's authorization server: bind a loopback callback, open the
 * browser, wait for the redirect, and exchange the code for tokens.
 * Reuses the same PKCE + localhost-callback machinery as the codebase
 * sign-in flow.
 */
export async function authorize(
	req: AuthorizeRequest,
	deps: AuthorizeDeps = {},
): Promise<{ tokens: OAuthTokens; client: RegisteredClient }> {
	const open = deps.open ?? openBrowser;
	const verifier = generateCodeVerifier();
	const challenge = generateCodeChallenge(verifier);
	const state = generateState();

	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	try {
		const port = (server.address() as AddressInfo).port;
		const redirectUri = `http://127.0.0.1:${port}/callback`;
		const client = await req.getClient(redirectUri);

		const authUrl = buildAuthUrl(req, client, challenge, state, redirectUri);
		deps.onAuthUrl?.(authUrl, req.serverName);
		if (!isHeadlessSession()) open(authUrl).catch(() => undefined);

		const { code } = await awaitCallback(server, state, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const tokens = await exchangeCode(
			{
				tokenEndpoint: req.metadata.token_endpoint,
				code,
				codeVerifier: verifier,
				redirectUri,
				client,
				resource: req.resource,
			},
			deps.fetchImpl,
		);
		return { tokens, client };
	} finally {
		try {
			server.close();
		} catch {
			// already closing
		}
	}
}

function buildAuthUrl(
	req: AuthorizeRequest,
	client: RegisteredClient,
	challenge: string,
	state: string,
	redirectUri: string,
): string {
	const u = new URL(req.metadata.authorization_endpoint);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", client.client_id);
	u.searchParams.set("redirect_uri", redirectUri);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("state", state);
	u.searchParams.set("resource", req.resource);
	if (req.scope) u.searchParams.set("scope", req.scope);
	return u.toString();
}
