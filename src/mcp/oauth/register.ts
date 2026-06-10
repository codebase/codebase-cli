import { CLIENT_INFO } from "../client.js";
import type { RegisteredClient } from "./types.js";

/**
 * Register a public client via RFC 7591 dynamic client registration.
 * MCP servers that gate on OAuth but don't pre-provision clients expose a
 * `registration_endpoint`; we register once and cache the returned
 * client_id. Native PKCE flow, so we ask for no client secret.
 */
export async function registerClient(
	registrationEndpoint: string,
	redirectUri: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RegisteredClient> {
	const res = await fetchImpl(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: CLIENT_INFO.name,
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`dynamic client registration failed: HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
		);
	}
	const body = (await res.json()) as { client_id?: string; client_secret?: string };
	if (!body.client_id) throw new Error("dynamic client registration returned no client_id");
	return { client_id: body.client_id, client_secret: body.client_secret };
}
