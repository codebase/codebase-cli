import type { Channel, OutboundMessage } from "./types.js";

/**
 * Actually puts an email on the wire. Injected into EmailChannel so the
 * channel logic is testable without a live mail server, and so the
 * transport (Microsoft Graph today, SMTP/Gmail later) can vary without
 * touching the channel.
 */
export type EmailTransport = (to: string, subject: string, body: string) => Promise<void>;

/** The email adapter for the Channel interface. */
export class EmailChannel implements Channel {
	readonly name = "email";

	constructor(private readonly transport: EmailTransport) {}

	async send(to: string, message: OutboundMessage): Promise<void> {
		await this.transport(to, message.subject ?? "(no subject)", message.body);
	}
}

/** Minimal fetch shape we depend on — keeps the transport unit-testable. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GraphTransportOptions {
	/** Returns a current Microsoft Graph bearer token. */
	getAccessToken: () => Promise<string>;
	/**
	 * Send as a specific mailbox (e.g. the director's own address) via
	 * /users/{from}/sendMail. Omit to send as the signed-in user (/me).
	 */
	from?: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/**
 * An EmailTransport backed by Microsoft Graph `sendMail`. Reuses the same
 * Graph surface we already use elsewhere; the caller supplies the token so
 * auth (app-only vs delegated) stays a separate concern.
 */
export function graphSendMailTransport(opts: GraphTransportOptions): EmailTransport {
	const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const endpoint = opts.from
		? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.from)}/sendMail`
		: "https://graph.microsoft.com/v1.0/me/sendMail";

	return async (to, subject, body) => {
		const token = await opts.getAccessToken();
		const res = await doFetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				message: {
					subject,
					body: { contentType: "Text", content: body },
					toRecipients: [{ emailAddress: { address: to } }],
				},
				saveToSentItems: true,
			}),
		});
		if (!res.ok) {
			throw new Error(`Graph sendMail failed: ${res.status} ${await res.text().catch(() => "")}`);
		}
	};
}
