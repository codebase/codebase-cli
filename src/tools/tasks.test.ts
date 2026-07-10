import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { TaskStore } from "./task-store.js";
import { createCreateTask, createGetTask, createListTasks, createUpdateTask } from "./tasks.js";
import type { ToolContext } from "./types.js";

function makeCtx(): ToolContext {
	return {
		cwd: process.cwd(),
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
	};
}

describe("task tools", () => {
	it("create_task assigns an id and starts pending", async () => {
		const ctx = makeCtx();
		const result = await createCreateTask(ctx).execute("c", {
			title: "Add OAuth refresh",
			description: "Implement the refresh path",
			active_form: "Adding OAuth refresh",
		});
		expect(result.details.id).toBe("task-1");
		expect(result.details.status).toBe("pending");
		expect(result.details.title).toBe("Add OAuth refresh");
		expect(result.details.activeForm).toBe("Adding OAuth refresh");
		expect(result.details.owner).toBeNull();
		expect(result.details.blockedBy).toEqual([]);
	});

	it("update_task moves a task through states", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c", { title: "First" });

		const inProg = await createUpdateTask(ctx).execute("u", { id: "task-1", status: "in_progress" });
		expect(inProg.details.status).toBe("in_progress");

		const done = await createUpdateTask(ctx).execute("u", { id: "task-1", status: "completed" });
		expect(done.details.status).toBe("completed");
	});

	it("update_task can change title and description without touching status", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c", { title: "old" });
		const result = await createUpdateTask(ctx).execute("u", {
			id: "task-1",
			title: "new",
			description: "now with notes",
		});
		expect(result.details.title).toBe("new");
		expect(result.details.description).toBe("now with notes");
		expect(result.details.status).toBe("pending");
	});

	it("update_task errors on unknown id", async () => {
		const ctx = makeCtx();
		await expect(createUpdateTask(ctx).execute("u", { id: "task-99", status: "completed" })).rejects.toThrow(
			/not found/,
		);
	});

	it("list_tasks returns all tasks by default", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c", { title: "a" });
		await createCreateTask(ctx).execute("c", { title: "b" });
		await createCreateTask(ctx).execute("c", { title: "c" });

		const result = await createListTasks(ctx).execute("l", {});
		expect(result.details.count).toBe(3);
		expect(result.details.tasks.map((t) => t.title)).toEqual(["a", "b", "c"]);
	});

	it("list_tasks filters by status", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c", { title: "a" });
		await createCreateTask(ctx).execute("c", { title: "b" });
		await createUpdateTask(ctx).execute("u", { id: "task-2", status: "completed" });

		const pending = await createListTasks(ctx).execute("l", { status: "pending" });
		const done = await createListTasks(ctx).execute("l", { status: "completed" });
		expect(pending.details.tasks.map((t) => t.title)).toEqual(["a"]);
		expect(done.details.tasks.map((t) => t.title)).toEqual(["b"]);
	});

	it("tracks owners, blockers, and available tasks", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c1", { title: "Design migration" });
		await createCreateTask(ctx).execute("c2", { title: "Implement migration", blocked_by: ["task-1"] });
		await createCreateTask(ctx).execute("c3", { title: "Review migration", owner: "reviewer" });

		const blocked = await createGetTask(ctx).execute("g", { id: "task-2" });
		const blocker = await createGetTask(ctx).execute("g", { id: "task-1" });
		expect(blocked.details.blockedBy).toEqual(["task-1"]);
		expect(blocker.details.blocks).toEqual(["task-2"]);

		const available = await createListTasks(ctx).execute("l", { available: true });
		expect(available.details.tasks.map((t) => t.id)).toEqual(["task-1"]);

		await expect(createUpdateTask(ctx).execute("u", { id: "task-2", status: "in_progress" })).rejects.toThrow(
			/blocked by task-1/,
		);

		await createUpdateTask(ctx).execute("u", { id: "task-1", status: "completed" });
		const newlyAvailable = await createListTasks(ctx).execute("l", { available: true });
		expect(newlyAvailable.details.tasks.map((t) => t.id)).toEqual(["task-2"]);
	});

	it("updates blocker edges bidirectionally", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c1", { title: "First" });
		await createCreateTask(ctx).execute("c2", { title: "Second" });

		await createUpdateTask(ctx).execute("u", { id: "task-1", add_blocks: ["task-2"], owner: "agent-a" });
		expect(ctx.tasks.get("task-1")?.blocks).toEqual(["task-2"]);
		expect(ctx.tasks.get("task-2")?.blockedBy).toEqual(["task-1"]);
		expect(ctx.tasks.get("task-1")?.owner).toBe("agent-a");

		await createUpdateTask(ctx).execute("u", { id: "task-1", remove_blocks: ["task-2"], clear_owner: true });
		expect(ctx.tasks.get("task-1")?.blocks).toEqual([]);
		expect(ctx.tasks.get("task-2")?.blockedBy).toEqual([]);
		expect(ctx.tasks.get("task-1")?.owner).toBeNull();
	});

	it("list_tasks shows a friendly message when empty", async () => {
		const ctx = makeCtx();
		const result = await createListTasks(ctx).execute("l", {});
		expect((result.content[0] as { type: "text"; text: string }).text).toBe("No tasks.");

		const filtered = await createListTasks(ctx).execute("l", { status: "completed" });
		expect((filtered.content[0] as { type: "text"; text: string }).text).toMatch(/No tasks with status completed/);
	});

	it("get_task returns the task or errors", async () => {
		const ctx = makeCtx();
		await createCreateTask(ctx).execute("c", { title: "only" });

		const ok = await createGetTask(ctx).execute("g", { id: "task-1" });
		expect(ok.details.title).toBe("only");

		await expect(createGetTask(ctx).execute("g", { id: "task-99" })).rejects.toThrow(/not found/);
	});

	it("subscribers receive a snapshot on every mutation", async () => {
		const ctx = makeCtx();
		const listener = vi.fn();
		ctx.tasks.subscribe(listener);

		await createCreateTask(ctx).execute("c", { title: "first" });
		await createUpdateTask(ctx).execute("u", { id: "task-1", status: "in_progress" });

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener.mock.calls[1][0][0].status).toBe("in_progress");
	});
});

describe("TaskStore", () => {
	it("persists tasks for a session and resumes the id counter", () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "codebase-task-store-"));
		const cwd = mkdtempSync(join(tmpdir(), "codebase-task-cwd-"));
		try {
			const first = new TaskStore({ cwd, taskListId: "s-test", dataRoot, watch: false });
			first.create({ title: "One", owner: "agent-a" });
			first.create({ title: "Two", blockedBy: ["task-1"] });

			const second = new TaskStore({ cwd, taskListId: "s-test", dataRoot, watch: false });
			expect(second.list().map((t) => t.title)).toEqual(["One", "Two"]);
			expect(second.get("task-1")?.owner).toBe("agent-a");
			expect(second.get("task-1")?.blocks).toEqual(["task-2"]);
			expect(second.get("task-2")?.blockedBy).toEqual(["task-1"]);
			expect(second.create({ title: "Three" }).id).toBe("task-3");
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects dependency cycles", () => {
		const store = new TaskStore();
		store.create({ title: "A" });
		store.create({ title: "B" });
		store.update("task-1", { addBlocks: ["task-2"] });

		expect(() => store.update("task-2", { addBlocks: ["task-1"] })).toThrow(/dependency cycle/);
	});

	it("can send an immediate snapshot to subscribers", () => {
		const store = new TaskStore();
		store.create({ title: "Already here" });
		const listener = vi.fn();

		store.subscribe(listener, { immediate: true });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0][0].title).toBe("Already here");
	});
});
