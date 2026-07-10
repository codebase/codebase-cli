import { describe, expect, it } from "vitest";
import { validateByokApiKey } from "./byok-key.js";

describe("validateByokApiKey", () => {
	it("rejects empty and short values", () => {
		expect(validateByokApiKey("anthropic", "")).toMatch(/Paste an API key/);
		expect(validateByokApiKey("anthropic", "bad")).toMatch(/too short/);
	});

	it("checks known provider prefixes", () => {
		expect(validateByokApiKey("anthropic", "sk-nope-abcdefghijklmnopqrstuvwxyz")).toMatch(/Anthropic keys/);
		expect(validateByokApiKey("anthropic", "sk-ant-abcdefghijklmnopqrstuvwxyz")).toBeNull();
		expect(validateByokApiKey("groq", "gsk_abcdefghijklmnopqrstuvwxyz")).toBeNull();
		expect(validateByokApiKey("xai", "xai-abcdefghijklmnopqrstuvwxyz")).toBeNull();
	});

	it("allows long keys for providers without a stable public prefix", () => {
		expect(validateByokApiKey("deepseek", "abcdefghijklmnopqrstuvwxyz")).toBeNull();
	});
});
