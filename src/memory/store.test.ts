import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";

describe("MemoryStore", () => {
	let dataRoot: string;
	let cwd: string;
	let store: MemoryStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "mem-data-"));
		cwd = mkdtempSync(join(tmpdir(), "mem-cwd-"));
		store = new MemoryStore({ cwd, dataRoot });
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("save then read round-trips frontmatter + body", () => {
		store.save({
			filename: "user_role.md",
			name: "User role",
			description: "Senior engineer",
			type: "user",
			body: "User is a senior dev with 10y Go.",
		});

		const record = store.read("user_role.md");
		expect(record).toMatchObject({
			filename: "user_role.md",
			name: "User role",
			description: "Senior engineer",
			type: "user",
		});
		expect(record?.body.trim()).toBe("User is a senior dev with 10y Go.");
	});

	it("writes durable provenance frontmatter and preserves created_at on overwrite", () => {
		const createdAt = Date.UTC(2026, 6, 7, 12);
		const updatedAt = Date.UTC(2026, 6, 8, 12);
		store = new MemoryStore({ cwd, dataRoot, sourceSessionId: "s-source-session" });
		store.save({
			filename: "project_rule.md",
			name: "Project rule",
			description: "Keep receipts",
			type: "project",
			body: "Always keep verification receipts.",
			source: "unit test",
			now: createdAt,
		});

		let raw = readFileSync(join(store.directory, "project_rule.md"), "utf8");
		expect(raw).toContain("source: unit test");
		expect(raw).toContain("source_session_id: s-source-session");
		expect(raw).toContain("created_at: 2026-07-07T12:00:00.000Z");
		expect(raw).toContain("updated_at: 2026-07-07T12:00:00.000Z");

		const overwritten = store.save({
			filename: "project_rule.md",
			name: "Project rule",
			description: "Keep receipts updated",
			type: "project",
			body: "Always keep fresh verification receipts.",
			now: updatedAt,
		});

		expect(overwritten.source).toBe("unit test");
		expect(overwritten.sourceSessionId).toBe("s-source-session");
		expect(overwritten.createdAt).toBe(createdAt);
		expect(overwritten.updatedAt).toBe(updatedAt);
		raw = readFileSync(join(store.directory, "project_rule.md"), "utf8");
		expect(raw).toContain("created_at: 2026-07-07T12:00:00.000Z");
		expect(raw).toContain("updated_at: 2026-07-08T12:00:00.000Z");
	});

	it("marks retrieval usage without refreshing updated_at", () => {
		const updatedAt = Date.UTC(2026, 6, 7, 12);
		const usedAt = Date.UTC(2026, 6, 9, 12);
		store.save({
			filename: "runbook.md",
			name: "Runbook",
			description: "Deploy runbook",
			type: "project",
			body: "Deploy carefully.",
			now: updatedAt,
		});

		const marked = store.markUsed("runbook.md", { now: usedAt });

		expect(marked).toMatchObject({
			filename: "runbook.md",
			updatedAt,
			lastUsedAt: usedAt,
			retrievalCount: 1,
		});
		const raw = readFileSync(join(store.directory, "runbook.md"), "utf8");
		expect(raw).toContain("updated_at: 2026-07-07T12:00:00.000Z");
		expect(raw).toContain("last_used_at: 2026-07-09T12:00:00.000Z");
		expect(raw).toContain("retrieval_count: 1");
		expect(store.read("runbook.md")).toMatchObject({ updatedAt, lastUsedAt: usedAt, retrievalCount: 1 });
	});

	it("reads legacy memory files without provenance frontmatter", () => {
		store.writeIndex("");
		writeFileSync(
			join(store.directory, "legacy.md"),
			"---\nname: Legacy\ndescription: Old format\ntype: project\n---\n\nbody\n",
		);

		const record = store.read("legacy.md");
		expect(record).toMatchObject({
			filename: "legacy.md",
			name: "Legacy",
			description: "Old format",
			type: "project",
			source: "local project memory",
			retrievalCount: 0,
		});
		expect(record?.createdAt).toEqual(expect.any(Number));
		expect(record?.updatedAt).toEqual(expect.any(Number));
	});

	it("redacts high-confidence secrets before durable save", () => {
		const fakeToken = "ghp_0123456789abcdef0123456789abcdef0123";
		const record = store.save({
			filename: "secret_note.md",
			name: `Token ${fakeToken}`,
			description: `Do not keep ${fakeToken}`,
			type: "feedback",
			body: `Never persist ${fakeToken} in memory.`,
		});

		expect(record.name).not.toContain(fakeToken);
		expect(record.description).not.toContain(fakeToken);
		expect(record.body).not.toContain(fakeToken);
		expect(record.body).toContain("[REDACTED]");
		expect(readFileSync(join(store.directory, "secret_note.md"), "utf8")).not.toContain(fakeToken);
	});

	it("rejects bad filenames", () => {
		expect(() =>
			store.save({
				filename: "../escape.md",
				name: "n",
				description: "d",
				type: "user",
				body: "",
			}),
		).toThrow(/filename must match/);
	});

	it("rejects unknown memory types", () => {
		expect(() =>
			store.save({
				filename: "x.md",
				name: "n",
				description: "d",
				type: "bogus" as never,
				body: "",
			}),
		).toThrow(/type must be/);
	});

	it("list returns saved records sorted by filename", () => {
		store.save({ filename: "a_first.md", name: "a", description: "1", type: "user", body: "" });
		store.save({ filename: "b_second.md", name: "b", description: "2", type: "feedback", body: "" });

		const all = store.list();
		expect(all.map((r) => r.filename)).toEqual(["a_first.md", "b_second.md"]);
	});

	it("list filters by type", () => {
		store.save({ filename: "u.md", name: "u", description: "u", type: "user", body: "" });
		store.save({ filename: "f.md", name: "f", description: "f", type: "feedback", body: "" });
		store.save({ filename: "p.md", name: "p", description: "p", type: "project", body: "" });

		const feedback = store.list("feedback");
		expect(feedback.map((r) => r.filename)).toEqual(["f.md"]);
	});

	it("list ignores MEMORY.md and non-md files", () => {
		store.writeIndex("# Index");
		writeFileSync(join(store.directory, "stray.txt"), "ignore me");
		expect(store.list()).toEqual([]);
	});

	it("read returns null for missing files", () => {
		expect(store.read("ghost.md")).toBeNull();
	});

	it("delete removes the file and returns true", () => {
		store.save({ filename: "drop.md", name: "x", description: "x", type: "user", body: "" });
		expect(store.delete("drop.md")).toBe(true);
		expect(store.read("drop.md")).toBeNull();
		expect(store.delete("drop.md")).toBe(false);
	});

	it("writeIndex/index round-trip", () => {
		expect(store.index()).toBe("");
		store.writeIndex("- [Foo](foo.md) — short");
		expect(store.index()).toBe("- [Foo](foo.md) — short");
	});

	it("truncatedIndex caps at 200 lines", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `- line ${i + 1}`);
		store.writeIndex(lines.join("\n"));
		const truncated = store.truncatedIndex();
		const truncatedLines = truncated.split("\n");
		expect(truncatedLines.length).toBeLessThanOrEqual(200);
		expect(truncatedLines[0]).toBe("- line 1");
	});

	it("truncatedIndex caps at 25KB cutting at newline boundaries", () => {
		const big = `- ${"x".repeat(1000)}\n`;
		const content = big.repeat(50);
		store.writeIndex(content);
		const truncated = store.truncatedIndex();
		expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(25_000);
		// Should not end mid-line
		expect(truncated.endsWith("\n") || truncated.length === 0 || /[a-z0-9-]$/.test(truncated)).toBe(true);
	});

	it("scopes to a per-project directory keyed by cwd hash", () => {
		const path = join(store.directory, "MEMORY.md");
		store.writeIndex("test");
		expect(readFileSync(path, "utf8")).toBe("test");
		expect(store.directory).toContain("/projects/");
		expect(store.directory).toContain("/memory");
	});

	it("each cwd gets its own directory", () => {
		const otherCwd = mkdtempSync(join(tmpdir(), "mem-cwd2-"));
		const other = new MemoryStore({ cwd: otherCwd, dataRoot });
		expect(other.directory).not.toBe(store.directory);
		rmSync(otherCwd, { recursive: true, force: true });
	});
});
