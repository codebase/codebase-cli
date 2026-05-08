import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("SessionStore", () => {
	let cwd: string;
	let dataRoot: string;
	let store: SessionStore;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ses-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "ses-data-"));
		store = new SessionStore({ cwd, dataRoot });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("save then load round-trips a session", () => {
		store.save({
			modelId: "claude-sonnet-4-6",
			title: "test",
			messages: [userMessage("hi")],
			usage: EMPTY_USAGE,
		});
		const loaded = store.load("claude-sonnet-4-6");
		expect(loaded?.title).toBe("test");
		expect(loaded?.messages).toHaveLength(1);
		expect(loaded?.workDir).toBe(cwd);
		expect(loaded?.formatVersion).toBe(SESSION_FORMAT_VERSION);
	});

	it("load returns null when no session exists", () => {
		expect(store.load("any-model")).toBeNull();
	});

	it("load returns null when the model id does not match", () => {
		store.save({
			modelId: "claude-sonnet-4-6",
			title: null,
			messages: [userMessage("hi")],
			usage: EMPTY_USAGE,
		});
		expect(store.load("gpt-5.1")).toBeNull();
		// File still exists for the original model
		expect(existsSync(store.filePath)).toBe(true);
	});

	it("load returns null and clears the file when the session is past max age", () => {
		store.save({
			modelId: "claude-sonnet-4-6",
			title: null,
			messages: [userMessage("hi")],
			usage: EMPTY_USAGE,
		});
		// backdate the file's mtime AND the saved updatedAt by re-writing.
		const past = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const path = store.filePath;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		raw.updatedAt = past;
		require("node:fs").writeFileSync(path, JSON.stringify(raw));
		const stale = new Date(past);
		utimesSync(path, stale, stale);

		const tightStore = new SessionStore({ cwd, dataRoot, maxAgeDays: 7 });
		expect(tightStore.load("claude-sonnet-4-6")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	it("load returns null on malformed JSON and clears the file", () => {
		require("node:fs").mkdirSync(join(dataRoot, "sessions"), { recursive: true });
		require("node:fs").writeFileSync(store.filePath, "not json");
		expect(store.load("any")).toBeNull();
		expect(existsSync(store.filePath)).toBe(false);
	});

	it("load returns null when messages array is empty", () => {
		store.save({
			modelId: "claude-sonnet-4-6",
			title: null,
			messages: [],
			usage: EMPTY_USAGE,
		});
		expect(store.load("claude-sonnet-4-6")).toBeNull();
	});

	it("save writes atomically (tmp file does not leak)", () => {
		store.save({
			modelId: "claude-sonnet-4-6",
			title: null,
			messages: [userMessage("hi")],
			usage: EMPTY_USAGE,
		});
		const dir = join(dataRoot, "sessions");
		const files = require("node:fs").readdirSync(dir);
		expect(files.some((f: string) => f.endsWith(".tmp"))).toBe(false);
	});

	it("clear removes the session file", () => {
		store.save({
			modelId: "x",
			title: null,
			messages: [userMessage("hi")],
			usage: EMPTY_USAGE,
		});
		expect(store.clear()).toBe(true);
		expect(store.clear()).toBe(false);
	});

	it("each cwd gets a distinct session file", () => {
		const otherCwd = mkdtempSync(join(tmpdir(), "ses-cwd2-"));
		const other = new SessionStore({ cwd: otherCwd, dataRoot });
		expect(other.filePath).not.toBe(store.filePath);
		rmSync(otherCwd, { recursive: true, force: true });
	});
});
