import { describe, expect, it } from "vitest";
import { parseCallbackPaste } from "./parse-callback.js";

describe("parseCallbackPaste", () => {
	it("parses a full callback URL", () => {
		const out = parseCallbackPaste("http://127.0.0.1:34233/callback?code=abc123&state=xyz789");
		expect(out).toEqual({ code: "abc123", state: "xyz789" });
	});

	it("trims whitespace before parsing", () => {
		const out = parseCallbackPaste("  http://127.0.0.1:34233/callback?code=abc&state=xyz  \n");
		expect(out).toEqual({ code: "abc", state: "xyz" });
	});

	it("parses an https callback URL with extra query params", () => {
		const out = parseCallbackPaste("https://localhost:8080/callback?code=abc&state=xyz&foo=bar");
		expect(out).toEqual({ code: "abc", state: "xyz" });
	});

	it("parses a bare query string with leading ?", () => {
		const out = parseCallbackPaste("?code=abc&state=xyz");
		expect(out).toEqual({ code: "abc", state: "xyz" });
	});

	it("parses a bare query string without ?", () => {
		const out = parseCallbackPaste("code=abc&state=xyz");
		expect(out).toEqual({ code: "abc", state: "xyz" });
	});

	it("parses the code#state shorthand", () => {
		const out = parseCallbackPaste("abc123#xyz789");
		expect(out).toEqual({ code: "abc123", state: "xyz789" });
	});

	it("returns null on empty input", () => {
		expect(parseCallbackPaste("")).toBeNull();
		expect(parseCallbackPaste("   ")).toBeNull();
	});

	it("returns null when code is missing", () => {
		expect(parseCallbackPaste("http://127.0.0.1/callback?state=xyz")).toBeNull();
	});

	it("returns null when state is missing", () => {
		expect(parseCallbackPaste("http://127.0.0.1/callback?code=abc")).toBeNull();
	});

	it("returns null on a non-URL, non-shorthand string", () => {
		expect(parseCallbackPaste("just some words")).toBeNull();
	});

	it("does not misinterpret a URL fragment as the # shorthand", () => {
		// "http://x?code=a&state=b" is the URL path; "#frag" is just fragment noise.
		const out = parseCallbackPaste("http://127.0.0.1/callback?code=a&state=b#fragment");
		expect(out).toEqual({ code: "a", state: "b" });
	});
});
