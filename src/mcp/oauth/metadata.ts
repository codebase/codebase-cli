import type { AuthServerMetadata, ProtectedResourceMetadata } from "./types.js";

/**
 * Pull the `resource_metadata` URL out of a 401's WWW-Authenticate
 * header (RFC 9728 §5.1). Returns undefined when the header is absent or
 * doesn't advertise one — the caller then falls back to the well-known
 * path on the server's own origin.
 */
export function parseWwwAuthenticate(header: string | null): string | undefined {
	if (!header) return undefined;
	const match = header.match(/resource_metadata\s*=\s*"([^"]+)"/i);
	return match?.[1];
}

/**
 * Discover the protected-resource metadata for a server. Prefers the URL
 * advertised on the 401; otherwise probes the RFC 9728 well-known path on
 * the server's origin.
 */
export async function discoverProtectedResource(
	serverUrl: string,
	advertised: string | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<ProtectedResourceMetadata> {
	const url = advertised ?? wellKnown(serverUrl, "oauth-protected-resource");
	const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`protected-resource metadata fetch failed: HTTP ${res.status} at ${url}`);
	return (await res.json()) as ProtectedResourceMetadata;
}

/**
 * Resolve an authorization server's metadata, trying the OAuth well-known
 * path first (RFC 8414) and falling back to the OIDC discovery document.
 * Throws only when neither yields a usable authorization + token endpoint.
 */
export async function discoverAuthServer(issuer: string, fetchImpl: typeof fetch = fetch): Promise<AuthServerMetadata> {
	const candidates = [wellKnown(issuer, "oauth-authorization-server"), wellKnown(issuer, "openid-configuration")];
	let lastErr: string | undefined;
	for (const url of candidates) {
		try {
			const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
			if (!res.ok) {
				lastErr = `HTTP ${res.status} at ${url}`;
				continue;
			}
			const meta = (await res.json()) as AuthServerMetadata;
			if (meta.authorization_endpoint && meta.token_endpoint) return meta;
			lastErr = `metadata at ${url} missing authorization/token endpoint`;
		} catch (err) {
			lastErr = `${(err as Error).message} at ${url}`;
		}
	}
	throw new Error(`could not discover authorization server metadata (${lastErr ?? "no candidates"})`);
}

/** Build a `/.well-known/<name>` URL on the origin of `base`, preserving no path. */
function wellKnown(base: string, name: string): string {
	const u = new URL(base);
	return `${u.origin}/.well-known/${name}`;
}
