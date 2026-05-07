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
