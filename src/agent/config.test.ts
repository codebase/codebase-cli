import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialsStore } from "../auth/credentials.js";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
	let dataRoot: string;
	let credentials: CredentialsStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "config-"));
		credentials = new CredentialsStore({ dataRoot });
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("uses byok credentials directly without the proxy", () => {
		credentials.save({
			accessToken: "sk-ant-test",
			scopes: [],
			source: "byok",
			provider: "anthropic",
		});

		const config = resolveConfig({ env: {}, credentials });

		expect(config.source).toBe("byok");
		expect(config.apiKey).toBe("sk-ant-test");
		expect(config.model.provider).toBe("anthropic");
		// The proxy baseUrl is set explicitly only for source=proxy. byok
		// must keep the provider's default baseUrl from pi-ai's registry.
		expect(config.model.baseUrl).not.toContain("codebase.foundation");
		expect(config.model.baseUrl).not.toContain("codebase.design");
	});

	it("resolves a stored openai-compat endpoint to a synthesized model", () => {
		credentials.save({
			accessToken: "none",
			scopes: [],
			source: "byok",
			provider: "openai-compat",
			baseUrl: "http://localhost:11434/v1",
			model: "llama3.3:70b",
		});

		const config = resolveConfig({ env: {}, credentials });

		expect(config.source).toBe("byok");
		expect(config.apiKey).toBe("none");
		expect(config.model.id).toBe("llama3.3:70b");
		expect(config.model.baseUrl).toBe("http://localhost:11434/v1");
	});

	it("a scan-detected context window overrides the template default", () => {
		credentials.save({
			accessToken: "none",
			scopes: [],
			source: "byok",
			provider: "openai-compat",
			baseUrl: "http://localhost:1234/v1",
			model: "qwen2.5-coder-32b",
			contextWindow: 32768,
		});

		const config = resolveConfig({ env: {}, credentials });

		expect(config.model.contextWindow).toBe(32768);
	});

	it("byok credentials win over env-var auto-detect", () => {
		credentials.save({
			accessToken: "sk-or-byok",
			scopes: [],
			source: "byok",
			provider: "openrouter",
		});
		// Anthropic key in env would normally be auto-detected first, but
		// saved credentials take priority.
		const config = resolveConfig({
			env: { ANTHROPIC_API_KEY: "sk-ant-env" },
			credentials,
		});

		expect(config.source).toBe("byok");
		expect(config.model.provider).toBe("openrouter");
		expect(config.apiKey).toBe("sk-or-byok");
	});
});
