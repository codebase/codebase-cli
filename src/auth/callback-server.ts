import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { constantTimeEquals } from "./pkce.js";

export interface CallbackResult {
	code: string;
	state: string;
}

/**
 * Spin a localhost HTTP server, listen for one /callback hit, return
 * the code+state. Validates the returned state against the supplied
 * value to defend against CSRF; treats anything else as an error.
 *
 * Resolves with { code, state } on success. Rejects on timeout, state
 * mismatch, or upstream error param.
 */
export function awaitCallback(server: Server, expectedState: string, timeoutMs: number): Promise<CallbackResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const safeResolve = (value: CallbackResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const safeReject = (err: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		};

		const timer = setTimeout(() => {
			server.close();
			safeReject(new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);

		server.on("request", (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== "/callback") {
				res.statusCode = 404;
				res.end("Not Found. The codebase OAuth callback expects /callback.");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const desc = url.searchParams.get("error_description") ?? "";
				renderResponse(res, false, `Sign-in failed: ${error}${desc ? ` — ${desc}` : ""}`);
				server.close();
				safeReject(new Error(`OAuth provider returned error: ${error}${desc ? ` — ${desc}` : ""}`));
				return;
			}
			const code = url.searchParams.get("code") ?? "";
			const state = url.searchParams.get("state") ?? "";
			if (!code) {
				renderResponse(res, false, "Sign-in failed: provider did not return a code.");
				server.close();
				safeReject(new Error("OAuth callback missing code parameter"));
				return;
			}
			if (!constantTimeEquals(state, expectedState)) {
				renderResponse(res, false, "Sign-in failed: state mismatch (possible CSRF).");
				server.close();
				safeReject(new Error("OAuth callback state mismatch"));
				return;
			}

			renderResponse(res, true, "Signed in. You can close this tab.");
			server.close();
			safeResolve({ code, state });
		});

		server.on("error", (err) => {
			safeReject(err);
		});
	});
}

function renderResponse(res: ServerResponse, ok: boolean, message: string): void {
	const title = ok ? "Signed in" : "Sign-in failed";
	const accent = ok ? "#22c55e" : "#ef4444";
	const subtitle = ok ? "You can close this tab." : "Return to your terminal for details.";
	// Inline SVG logo + minimal CSS. No external deps so the page renders
	// before any network even on the CLI's localhost-only callback host.
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codebase · ${title}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
	background: #0a0a0b;
	color: #f1f1f3;
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
}
@media (prefers-color-scheme: light) {
	body { background: #fafafa; color: #0a0a0b; }
	.card { background: #fff; border-color: #e5e5ea; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06); }
	.subtitle { color: #6b6b73; }
	.hint { color: #6b6b73; }
}
.card {
	max-width: 440px;
	width: 100%;
	padding: 40px 36px 32px;
	border: 1px solid #1f1f23;
	border-radius: 16px;
	background: #131316;
	box-shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.4);
	text-align: center;
}
.logo {
	width: 64px;
	height: 64px;
	margin: 0 auto 24px;
	display: block;
}
.logo rect { fill: currentColor; }
.icon {
	width: 48px;
	height: 48px;
	margin: 0 auto 12px;
	border-radius: 999px;
	background: ${accent}22;
	color: ${accent};
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 28px;
	font-weight: 600;
}
h1 {
	font-size: 22px;
	font-weight: 600;
	margin: 0 0 4px;
	letter-spacing: -0.01em;
}
.subtitle {
	color: #a3a3ab;
	font-size: 14px;
	margin: 0 0 24px;
}
.message {
	background: rgba(255,255,255,0.04);
	border: 1px solid rgba(255,255,255,0.06);
	padding: 12px 14px;
	border-radius: 8px;
	font-size: 13px;
	text-align: center;
	white-space: pre-wrap;
}
@media (prefers-color-scheme: light) {
	.message { background: #f5f5f7; border-color: #e5e5ea; }
}
.hint {
	margin-top: 18px;
	font-size: 12px;
	color: #6b6b73;
}
.brand {
	font-size: 12px;
	color: #6b6b73;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	margin-bottom: 8px;
}
</style>
</head>
<body>
<div class="card">
	<svg class="logo" viewBox="7 6 6 7" shape-rendering="crispEdges" aria-hidden="true">
		<rect width="1" height="1" x="9" y="7" /><rect width="1" height="1" x="10" y="7" /><rect width="1" height="1" x="11" y="7" />
		<rect width="1" height="1" x="8" y="8" /><rect width="1" height="1" x="8" y="9" /><rect width="1" height="1" x="8" y="10" />
		<rect width="1" height="1" x="9" y="11" /><rect width="1" height="1" x="10" y="11" /><rect width="1" height="1" x="11" y="11" />
	</svg>
	<div class="brand">codebase</div>
	<div class="icon" aria-hidden="true">${ok ? "✓" : "!"}</div>
	<h1>${title}</h1>
	<p class="subtitle">${subtitle}</p>
	<div class="message">${escapeHtml(message)}</div>
	<p class="hint">${ok ? "Your terminal is signed in via codebase.design." : "Try <code>codebase auth login</code> again, or check your terminal for the error."}</p>
</div>
</body>
</html>`;
	res.statusCode = ok ? 200 : 400;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(html);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
