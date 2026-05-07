import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	url: Type.String({
		description: "Absolute http(s) URL.",
	}),
	method: Type.Optional(
		Type.Union([Type.Literal("GET"), Type.Literal("HEAD")], {
			description: "GET (default) or HEAD.",
		}),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Extra request headers (e.g. Authorization, User-Agent).",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 100,
			maximum: 60_000,
			description: "Abort after this many ms. Default 15000, max 60000.",
		}),
	),
	max_bytes: Type.Optional(
		Type.Integer({
			minimum: 1024,
			maximum: 1_000_000,
			description: "Cap on bytes returned. Default 100000, max 1000000.",
		}),
	),
});

export type WebFetchParams = Static<typeof Params>;

export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string | null;
	bytes: number;
	truncated: boolean;
	durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 100_000;

const DESCRIPTION = `Fetch an http(s) URL and return the response body as text.

Behavior:
- GET by default; HEAD for header-only checks.
- Default timeout 15s (max 60s); aborts cleanly on the agent's abort signal.
- Body is decoded as UTF-8 and capped at 100 KB by default; truncation reported in details.
- Redirects are followed automatically. The final URL is reported in details.
- Errors (DNS, connect, TLS) bubble up with the underlying message — they do not retry.

Use this for documentation/spec lookups when you have a URL. For discovery use web_search.`;

export function createWebFetch(_ctx: ToolContext): AgentTool<typeof Params, WebFetchDetails> {
	return {
		name: "web_fetch",
		label: "Fetch",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			validateUrl(params.url);

			const method = params.method ?? "GET";
			const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const maxBytes = params.max_bytes ?? DEFAULT_MAX_BYTES;

			const startedAt = Date.now();
			const controller = new AbortController();
			const onUpstreamAbort = () => controller.abort();
			signal?.addEventListener("abort", onUpstreamAbort);
			const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

			let response: Response;
			try {
				response = await fetch(params.url, {
					method,
					headers: params.headers,
					redirect: "follow",
					signal: controller.signal,
				});
			} catch (err) {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onUpstreamAbort);
				const reason = err instanceof Error ? err.message : String(err);
				if (reason.toLowerCase().includes("timeout")) {
					throw new Error(`web_fetch timed out after ${Math.round(timeoutMs / 1000)}s.`);
				}
				throw new Error(`web_fetch failed: ${reason}`);
			}

			let body = "";
			let truncated = false;
			let bytes = 0;

			if (method === "GET" && response.body) {
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						bytes += value.byteLength;
						if (bytes > maxBytes) {
							truncated = true;
							const room = maxBytes - (bytes - value.byteLength);
							if (room > 0) chunks.push(value.subarray(0, room));
							controller.abort();
							break;
						}
						chunks.push(value);
					}
				} finally {
					try {
						reader.releaseLock();
					} catch {
						// already released
					}
					clearTimeout(timer);
					signal?.removeEventListener("abort", onUpstreamAbort);
				}
				body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
			} else {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onUpstreamAbort);
			}

			const durationMs = Date.now() - startedAt;
			const contentType = response.headers.get("content-type");
			const summary = formatSummary(params.url, response, contentType, bytes, truncated, durationMs, body);

			return {
				content: [{ type: "text", text: summary }],
				details: {
					url: params.url,
					finalUrl: response.url,
					status: response.status,
					statusText: response.statusText,
					contentType,
					bytes,
					truncated,
					durationMs,
				},
			};
		},
	};
}

function validateUrl(raw: string): void {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`URL must be http or https; got ${parsed.protocol}`);
	}
}

function formatSummary(
	url: string,
	response: Response,
	contentType: string | null,
	bytes: number,
	truncated: boolean,
	durationMs: number,
	body: string,
): string {
	const lines: string[] = [];
	const finalUrl = response.url && response.url !== url ? `\nFinal: ${response.url}` : "";
	lines.push(
		`${response.status} ${response.statusText} (${durationMs}ms, ${bytes} bytes${truncated ? ", truncated" : ""})${finalUrl}`,
	);
	if (contentType) lines.push(`Content-Type: ${contentType}`);
	if (body) {
		lines.push("");
		lines.push(body);
	}
	return lines.join("\n");
}
