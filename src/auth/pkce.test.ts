import { describe, expect, it } from "vitest";
import { base64url, constantTimeEquals, generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";

describe("base64url", () => {
	it("encodes without padding and replaces +//", () => {
		const buf = Buffer.from([0x3e, 0x3f, 0x5a, 0xfa]);
		const encoded = base64url(buf);
		expect(encoded).not.toContain("=");
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
	});
});

describe("generateCodeVerifier", () => {
	it("produces a 43+ character base64url string", () => {
		const verifier = generateCodeVerifier();
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("yields different verifiers across calls", () => {
		expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
	});
});

describe("generateCodeChallenge", () => {
	it("derives a 43-character base64url SHA-256 digest", () => {
		const verifier = "test-verifier-123";
		const challenge = generateCodeChallenge(verifier);
		expect(challenge.length).toBe(43);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("is deterministic for a given verifier", () => {
		const verifier = "fixed-verifier-string";
		expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier));
	});

	it("rejects empty input", () => {
		expect(() => generateCodeChallenge("")).toThrow(/non-empty/);
	});

	it("matches the RFC 7636 example vector", () => {
		// Example from RFC 7636 §A.1
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const challenge = generateCodeChallenge(verifier);
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});

describe("generateState", () => {
	it("returns a random base64url string", () => {
		const state = generateState();
		expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(state.length).toBeGreaterThan(20);
	});

	it("is unique across calls", () => {
		expect(generateState()).not.toBe(generateState());
	});
});

describe("constantTimeEquals", () => {
	it("returns true for equal strings", () => {
		expect(constantTimeEquals("abc123", "abc123")).toBe(true);
	});

	it("returns false for different strings of the same length", () => {
		expect(constantTimeEquals("abc123", "abc124")).toBe(false);
	});

	it("returns false for different lengths", () => {
		expect(constantTimeEquals("abc", "abcd")).toBe(false);
	});
});
