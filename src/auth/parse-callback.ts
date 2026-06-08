/**
 * Parse what the user pasted from a failed OAuth redirect back into a
 * `{ code, state }` pair the flow can complete with.
 *
 * Three accepted shapes (most flexible first so we catch real-world
 * paste patterns):
 *
 * 1. Full callback URL — what the browser address bar shows when the
 *    redirect to 127.0.0.1 hits "connection refused" but still lands
 *    on the URL:
 *      http://127.0.0.1:34233/callback?code=XYZ&state=ABC
 *
 * 2. Bare query string — the user manually trimmed the host part:
 *      ?code=XYZ&state=ABC
 *      code=XYZ&state=ABC
 *
 * 3. `code#state` shorthand — matches Claude Code's manual paste
 *    convention if the user is pasting from a server-side "manual"
 *    redirect that shows the two values concatenated.
 *
 * Returns `null` when nothing matches so the wizard can show a "try
 * again" message instead of submitting garbage to the token endpoint.
 */
export function parseCallbackPaste(input: string): { code: string; state: string } | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// Try as a full URL first.
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (code && state) return { code, state };
	} catch {
		// Not a URL; fall through.
	}

	// Bare query string ("?code=...&state=..." or "code=...&state=...").
	if (trimmed.includes("code=") && trimmed.includes("state=")) {
		try {
			const qs = new URLSearchParams(trimmed.replace(/^\?/, ""));
			const code = qs.get("code");
			const state = qs.get("state");
			if (code && state) return { code, state };
		} catch {
			// Fall through to the # shorthand.
		}
	}

	// `code#state` shorthand. The split is unambiguous because OAuth codes
	// are URL-safe base64 (no `#`).
	if (trimmed.includes("#") && !trimmed.includes(" ")) {
		const [code, state] = trimmed.split("#", 2);
		if (code && state) return { code, state };
	}

	return null;
}
