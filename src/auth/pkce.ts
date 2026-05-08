import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE helpers for RFC 7636. Used by the OAuth flow to bind the
 * /callback redirect to this specific login attempt — without these
 * the auth code on the redirect URL would be replayable.
 */

const VERIFIER_BYTE_LENGTH = 64;
const STATE_BYTE_LENGTH = 24;

/**
 * Base64url encoding without padding (RFC 7636 §4.2). Node's
 * `Buffer.toString("base64url")` lands in the right shape; this
 * wrapper exists so call sites can swap to a different encoder
 * without rippling through.
 */
export function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/** Generate the code_verifier — 64 random bytes, base64url-encoded. */
export function generateCodeVerifier(): string {
	return base64url(randomBytes(VERIFIER_BYTE_LENGTH));
}

/** Derive the code_challenge from a code_verifier using SHA-256 (RFC 7636 §4.2). */
export function generateCodeChallenge(verifier: string): string {
	if (typeof verifier !== "string" || verifier.length === 0) {
		throw new Error("code verifier must be a non-empty string");
	}
	return base64url(createHash("sha256").update(verifier).digest());
}

/** Generate an anti-CSRF state token, base64url-encoded random bytes. */
export function generateState(): string {
	return base64url(randomBytes(STATE_BYTE_LENGTH));
}

/**
 * Constant-time comparison for state validation to avoid timing leaks
 * in the (unlikely) event an attacker probes the callback handler.
 */
export function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
