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

	it("re-chmods to 0600 on load if the file was made world-readable", () => {
		if (process.platform === "win32") return; // no posix modes
		store.save({ accessToken: "x", scopes: [], source: "manual" });
		// Simulate user chmod or a permissive umask after save.
		require("node:fs").chmodSync(store.filePath, 0o644);
		expect(store.mode()).toBe(0o644);
		// Stderr warning is the spec for this branch; capture so we don't
		// pollute the test runner output.
		const origWrite = process.stderr.write.bind(process.stderr);
		let warned = "";
		process.stderr.write = ((chunk: string | Uint8Array) => {
			warned += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stderr.write;
		try {
			const creds = store.load();
			expect(creds).not.toBeNull();
		} finally {
			process.stderr.write = origWrite;
		}
		expect(warned).toContain("credentials file mode is 0644");
		expect(store.mode()).toBe(0o600);
	});

	it("load returns null when no file exists", () => {
		expect(store.load()).toBeNull();
	});

	it("load returns null on malformed JSON without clearing the file", () => {
		// Don't auto-clear: a partially-written credentials file (power
		// cut mid-save, manual edit conflict) might be hand-recoverable.
		// We surface the parse error to stderr; the user can choose to
		// `codebase auth logout` if they want to wipe it.
		require("node:fs").mkdirSync(dataRoot, { recursive: true });
		require("node:fs").writeFileSync(store.filePath, "not json");
		expect(store.load()).toBeNull();
		expect(existsSync(store.filePath)).toBe(true);
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

	it("byok credentials round-trip with their provider", () => {
		store.save({ accessToken: "sk-ant-foo", scopes: [], source: "byok", provider: "anthropic" });
		const loaded = store.load();
		expect(loaded?.source).toBe("byok");
		expect(loaded?.provider).toBe("anthropic");
		expect(loaded?.accessToken).toBe("sk-ant-foo");
	});

	it("byok credentials without a provider field are rejected", () => {
		require("node:fs").mkdirSync(dataRoot, { recursive: true });
		require("node:fs").writeFileSync(
			store.filePath,
			JSON.stringify({ version: 1, accessToken: "sk-...", scopes: [], source: "byok" }),
		);
		expect(store.load()).toBeNull();
	});
});
