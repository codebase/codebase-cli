import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_FORMAT_VERSION, SessionStore } from "./store.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function mkdtempSyncIn(prefix: string): string {
	return require("node:fs").mkdtempSync(join(tmpdir(), prefix));
}

describe("SessionStore", () => {
	let cwd: string;
	let dataRoot: string;
	let store: SessionStore;

	beforeEach(() => {
		cwd = mkdtempSyncIn("ses-cwd-");
		dataRoot = mkdtempSyncIn("ses-data-");
		store = new SessionStore({ cwd, dataRoot });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	function save(s: SessionStore, modelId = "claude-sonnet-4-6", title: string | null = "test"): void {
		s.save({ modelId, title, messages: [userMessage("hi")], usage: EMPTY_USAGE });
	}

	it("save then load round-trips a session", () => {
		save(store);
		const loaded = store.load("claude-sonnet-4-6");
		expect(loaded?.title).toBe("test");
		expect(loaded?.messages).toHaveLength(1);
		expect(loaded?.workDir).toBe(cwd);
		expect(loaded?.formatVersion).toBe(SESSION_FORMAT_VERSION);
	});

	it("load returns null when no session exists", () => {
		expect(store.load("any-model")).toBeNull();
	});

	it("load returns null when the model id does not match, file kept", () => {
		save(store, "claude-sonnet-4-6");
		expect(store.load("gpt-5.1")).toBeNull();
		expect(existsSync(store.filePath)).toBe(true);
	});

	it("load prunes a session past max age", () => {
		save(store);
		const raw = JSON.parse(readFileSync(store.filePath, "utf8"));
		raw.updatedAt = Date.now() - 60 * 24 * 60 * 60 * 1000;
		writeFileSync(store.filePath, JSON.stringify(raw));
		const path = store.filePath;

		const tightStore = new SessionStore({ cwd, dataRoot, maxAgeDays: 7 });
		expect(tightStore.load("claude-sonnet-4-6")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	it("load skips and prunes malformed session files", () => {
		mkdirSync(dirname(store.filePath), { recursive: true });
		writeFileSync(store.filePath, "not json");
		expect(store.load("any")).toBeNull();
		expect(existsSync(store.filePath)).toBe(false);
	});

	it("load returns null when messages array is empty", () => {
		store.save({ modelId: "claude-sonnet-4-6", title: null, messages: [], usage: EMPTY_USAGE });
		expect(store.load("claude-sonnet-4-6")).toBeNull();
	});

	it("save writes atomically (tmp file does not leak)", () => {
		save(store);
		const files = readdirSync(dirname(store.filePath));
		expect(files.some((f: string) => f.endsWith(".tmp"))).toBe(false);
	});

	it("clear removes the session file", () => {
		save(store, "x");
		expect(store.clear()).toBe(true);
		expect(store.clear()).toBe(false);
	});

	it("each cwd gets a distinct session dir", () => {
		const otherCwd = mkdtempSyncIn("ses-cwd2-");
		const other = new SessionStore({ cwd: otherCwd, dataRoot });
		expect(dirname(other.filePath)).not.toBe(dirname(store.filePath));
		rmSync(otherCwd, { recursive: true, force: true });
	});

	describe("multi-session", () => {
		it("a second store mints a new session instead of overwriting", () => {
			save(store, "m", "first");
			const second = new SessionStore({ cwd, dataRoot });
			save(second, "m", "second");
			expect(second.filePath).not.toBe(store.filePath);
			expect(second.list()).toHaveLength(2);
		});

		it("list returns sessions newest first with summaries", () => {
			save(store, "m", "older");
			const newer = new SessionStore({ cwd, dataRoot });
			save(newer, "m", "newer");
			// Force a strictly later updatedAt for the newer session.
			const raw = JSON.parse(readFileSync(newer.filePath, "utf8"));
			raw.updatedAt = Date.now() + 1000;
			writeFileSync(newer.filePath, JSON.stringify(raw));

			const list = store.list();
			expect(list).toHaveLength(2);
			expect(list[0].title).toBe("newer");
			expect(list[0]).toMatchObject({ modelId: "m", messageCount: 1 });
		});

		it("load adopts the resumed session's id so saves continue it", () => {
			save(store, "m", "original");
			const resumer = new SessionStore({ cwd, dataRoot });
			const loaded = resumer.load("m");
			expect(loaded?.title).toBe("original");
			expect(resumer.id).toBe(store.id);
			save(resumer, "m", "continued");
			expect(resumer.list()).toHaveLength(1); // continued, not forked
		});

		it("loadById resumes a specific session regardless of model", () => {
			save(store, "old-model", "picked");
			const resumer = new SessionStore({ cwd, dataRoot });
			const loaded = resumer.loadById(store.id);
			expect(loaded?.title).toBe("picked");
			expect(resumer.id).toBe(store.id);
		});

		it("loadById returns null for unknown or invalid ids", () => {
			expect(store.loadById("does-not-exist")).toBeNull();
			expect(store.loadById("../../etc/passwd")).toBeNull();
		});

		it("auto-titles a session from its first user prompt", () => {
			store.save({
				modelId: "m",
				title: null,
				messages: [userMessage("fix the flaky login test in auth.spec.ts")],
				usage: EMPTY_USAGE,
			});
			expect(store.list()[0].title).toBe("fix the flaky login test in auth.spec.ts");
		});

		it("migrates the legacy single-file layout into the directory", () => {
			const legacy = new SessionStore({ cwd, dataRoot });
			save(legacy, "m", "old conversation");
			// Reconstruct the legacy layout: move the session file up to
			// sessions/<hash>.json as the pre-multi-session code wrote it.
			const dir = dirname(legacy.filePath);
			const legacyPath = `${dir}.json`;
			writeFileSync(legacyPath, readFileSync(legacy.filePath));
			rmSync(dir, { recursive: true, force: true });

			const migrated = new SessionStore({ cwd, dataRoot });
			expect(existsSync(legacyPath)).toBe(false);
			const list = migrated.list();
			expect(list).toHaveLength(1);
			expect(list[0].title).toBe("old conversation");
			expect(migrated.loadById(list[0].id)?.title).toBe("old conversation");
		});
	});
});
