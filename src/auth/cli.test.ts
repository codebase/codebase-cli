import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAuthSubcommand } from "./cli.js";
import { CredentialsStore } from "./credentials.js";

describe("runAuthSubcommand", () => {
	let dataRoot: string;
	let store: CredentialsStore;
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "auth-cli-"));
		store = new CredentialsStore({ dataRoot });
		stdout = [];
		stderr = [];
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	function run(argv: string[]) {
		return runAuthSubcommand(argv, {
			store,
			stdout: (m) => stdout.push(m),
			stderr: (m) => stderr.push(m),
		});
	}

	it("status with no credentials prints onboarding hint", async () => {
		const code = await run(["auth"]);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/not signed in/);
		expect(stdout.join("\n")).toMatch(/codebase auth login/);
	});

	it("status with credentials prints the source + scopes", async () => {
		store.save({
			accessToken: "tok",
			scopes: ["inference", "credits"],
			source: "codebase",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		});
		const code = await run(["auth", "status"]);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/signed in via codebase/);
		expect(stdout.join("\n")).toMatch(/user@example.com/);
		expect(stdout.join("\n")).toMatch(/inference credits/);
	});

	it("logout clears credentials", async () => {
		store.save({ accessToken: "x", scopes: [], source: "manual" });
		const code = await run(["auth", "logout"]);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/signed out/);
		expect(store.load()).toBeNull();
	});

	it("logout with no credentials reports nothing to remove", async () => {
		const code = await run(["auth", "logout"]);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/no credentials/);
	});

	it("manual API key argument saves credentials with source=manual", async () => {
		const code = await run(["auth", "sk-codebase-abcdef0123456789xyz"]);
		expect(code).toBe(0);
		const loaded = store.load();
		expect(loaded?.source).toBe("manual");
		expect(loaded?.accessToken).toBe("sk-codebase-abcdef0123456789xyz");
	});

	it("rejects keys that look too short to be real", async () => {
		const code = await run(["auth", "short"]);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toMatch(/too short/);
	});

	it("rejects unknown flags with exit 2", async () => {
		const code = await run(["auth", "--no-such-flag"]);
		expect(code).toBe(2);
		expect(stderr.join("\n")).toMatch(/unknown flag/);
	});

	it("refresh fails cleanly when no credentials are present", async () => {
		const code = await run(["auth", "refresh"]);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toMatch(/not signed in/);
	});

	it("refresh fails cleanly when credentials lack a refresh token (manual)", async () => {
		store.save({ accessToken: "x", scopes: [], source: "manual" });
		const code = await run(["auth", "refresh"]);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toMatch(/can't be refreshed/);
	});
});
