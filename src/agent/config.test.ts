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
