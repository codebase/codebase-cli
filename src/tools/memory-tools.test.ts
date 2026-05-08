import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../memory/store.js";
import { PlanModeStore } from "../plan/store.js";
import { UserQueryStore } from "../user-queries/store.js";
import { FileStateCache } from "./file-state-cache.js";
import { createReadMemory, createSaveMemory } from "./memory-tools.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string, dataRoot: string): ToolContext {
	return {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries: new UserQueryStore(),
		planMode: new PlanModeStore(),
		memory: new MemoryStore({ cwd, dataRoot }),
		spawnSubagent: () => {
			throw new Error("not used in tests");
		},
	};
}

describe("save_memory", () => {
	let cwd: string;
	let dataRoot: string;
	let ctx: ToolContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mt-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "mt-data-"));
		ctx = makeCtx(cwd, dataRoot);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("writes the memory file and updates MEMORY.md", async () => {
		await createSaveMemory(ctx).execute(
			"s",
			{
				filename: "user_role.md",
				name: "User role",
				description: "Senior engineer",
				type: "user",
				body: "Background: 10 years Go, new to TS.",
			},
			undefined,
		);

		const stored = ctx.memory.read("user_role.md");
		expect(stored?.body.trim()).toBe("Background: 10 years Go, new to TS.");

		const indexPath = join(ctx.memory.directory, "MEMORY.md");
		const indexBody = readFileSync(indexPath, "utf8");
		expect(indexBody).toContain("[User role](user_role.md)");
		expect(indexBody).toContain("Senior engineer");
	});

	it("rejects bad filenames with the LLM-facing error", async () => {
		await expect(
			createSaveMemory(ctx).execute(
				"s",
				{ filename: "../escape.md", name: "n", description: "d", type: "user", body: "" },
				undefined,
			),
		).rejects.toThrow(/filename must match/);
	});
});

describe("read_memory", () => {
	let cwd: string;
	let dataRoot: string;
	let ctx: ToolContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mt-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "mt-data-"));
		ctx = makeCtx(cwd, dataRoot);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	async function seed() {
		await createSaveMemory(ctx).execute(
			"s1",
			{ filename: "user_a.md", name: "User a", description: "u-desc", type: "user", body: "u-body" },
			undefined,
		);
		await createSaveMemory(ctx).execute(
			"s2",
			{ filename: "feedback_b.md", name: "Feedback b", description: "f-desc", type: "feedback", body: "f-body" },
			undefined,
		);
	}

	it("returns the index when no args", async () => {
		await seed();
		const result = await createReadMemory(ctx).execute("r", {}, undefined);
		expect(result.details.mode).toBe("index");
		expect(result.details.index).toContain("[User a](user_a.md)");
		expect(result.details.index).toContain("[Feedback b](feedback_b.md)");
	});

	it("filters by type", async () => {
		await seed();
		const result = await createReadMemory(ctx).execute("r", { type: "feedback" }, undefined);
		expect(result.details.mode).toBe("list");
		expect(result.details.records?.map((r) => r.filename)).toEqual(["feedback_b.md"]);
	});

	it("returns a single record by filename", async () => {
		await seed();
		const result = await createReadMemory(ctx).execute("r", { filename: "user_a.md" }, undefined);
		expect(result.details.mode).toBe("single");
		expect(result.details.record?.body).toContain("u-body");
	});

	it("errors with a clear message on missing filename", async () => {
		await expect(createReadMemory(ctx).execute("r", { filename: "ghost.md" }, undefined)).rejects.toThrow(
			/not found/,
		);
	});

	it("returns a friendly empty message for an empty type", async () => {
		await seed();
		const result = await createReadMemory(ctx).execute("r", { type: "project" }, undefined);
		expect((result.content[0] as { text: string }).text).toMatch(/no memories of type project/);
	});
});
