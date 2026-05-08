import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialsStore } from "./credentials.js";

describe("CredentialsStore", () => {
	let dataRoot: string;
	let store: CredentialsStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "creds-"));
		store = new CredentialsStore({ dataRoot });
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("save then load round-trips credentials", () => {
		store.save({
			accessToken: "token-abc",
			refreshToken: "refresh-xyz",
			expiresAt: Date.now() + 3_600_000,
			scopes: ["inference", "credits"],
			userId: "u1",
			email: "user@example.com",
			source: "codebase",
		});
		const loaded = store.load();
		expect(loaded?.accessToken).toBe("token-abc");
		expect(loaded?.refreshToken).toBe("refresh-xyz");
		expect(loaded?.scopes).toEqual(["inference", "credits"]);
		expect(loaded?.email).toBe("user@example.com");
		expect(loaded?.source).toBe("codebase");
	});

	it("writes the credentials file with mode 0600", () => {
		store.save({ accessToken: "x", scopes: [], source: "manual" });
		// On platforms that support file modes
		if (process.platform !== "win32") {
			expect(store.mode()).toBe(0o600);
		}
	});

	it("load returns null when no file exists", () => {
		expect(store.load()).toBeNull();
	});

	it("load returns null and clears the file on malformed JSON", () => {
		require("node:fs").mkdirSync(dataRoot, { recursive: true });
		require("node:fs").writeFileSync(store.filePath, "not json");
		expect(store.load()).toBeNull();
		expect(existsSync(store.filePath)).toBe(false);
	});

	it("load rejects unrecognized versions", () => {
		store.save({ accessToken: "x", scopes: [], source: "codebase" });
		const raw = JSON.parse(readFileSync(store.filePath, "utf8"));
		raw.version = 999;
		require("node:fs").writeFileSync(store.filePath, JSON.stringify(raw));
		expect(store.load()).toBeNull();
	});

	it("load rejects missing accessToken", () => {
		require("node:fs").mkdirSync(dataRoot, { recursive: true });
		require("node:fs").writeFileSync(store.filePath, JSON.stringify({ version: 1, scopes: [], source: "codebase" }));
		expect(store.load()).toBeNull();
	});

	it("load rejects unknown source values", () => {
		require("node:fs").mkdirSync(dataRoot, { recursive: true });
		require("node:fs").writeFileSync(
			store.filePath,
			JSON.stringify({ version: 1, accessToken: "x", scopes: [], source: "untrusted" }),
		);
		expect(store.load()).toBeNull();
	});

	it("clear removes the file", () => {
		store.save({ accessToken: "x", scopes: [], source: "manual" });
		expect(store.clear()).toBe(true);
		expect(store.clear()).toBe(false);
		expect(existsSync(store.filePath)).toBe(false);
	});

	it("isExpired honors expiresAt with a 60s skew window", () => {
		const fresh = {
			version: 1 as const,
			accessToken: "x",
			scopes: [],
			source: "codebase" as const,
			expiresAt: Date.now() + 10 * 60_000,
		};
		expect(store.isExpired(fresh)).toBe(false);

		const stale = { ...fresh, expiresAt: Date.now() - 1000 };
		expect(store.isExpired(stale)).toBe(true);

		const noExpiry = { ...fresh, expiresAt: undefined };
		expect(store.isExpired(noExpiry)).toBe(false);

		const aboutToExpire = { ...fresh, expiresAt: Date.now() + 30_000 }; // <60s skew
		expect(store.isExpired(aboutToExpire)).toBe(true);
	});

	it("save survives an existing file (overwrites)", () => {
		store.save({ accessToken: "v1", scopes: [], source: "manual" });
		store.save({ accessToken: "v2", scopes: [], source: "manual" });
		expect(store.load()?.accessToken).toBe("v2");
	});
});
