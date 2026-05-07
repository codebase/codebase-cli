import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { Task, TaskStatus } from "./task-store.js";
import type { ToolContext } from "./types.js";

const StatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

// ─── create_task ─────────────────────────────────────────────

const CreateParams = Type.Object({
	title: Type.String({
		minLength: 1,
		maxLength: 200,
		description: "Short task name. Imperative form (e.g. 'Add OAuth refresh token').",
	}),
	description: Type.Optional(Type.String({ description: "Free-form longer description." })),
	active_form: Type.Optional(
		Type.String({
			description: "Verb-ing form for live display while task is in progress (e.g. 'Adding OAuth refresh token').",
		}),
	),
});

export type CreateTaskParams = Static<typeof CreateParams>;

export function createCreateTask(ctx: ToolContext): AgentTool<typeof CreateParams, Task> {
	return {
		name: "create_task",
		label: "New task",
		description:
			"Add a task to the agent's checklist. Returns the task with an assigned id. Status starts as 'pending'.",
		parameters: CreateParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const task = ctx.tasks.create({
				title: params.title,
				description: params.description ?? null,
				activeForm: params.active_form ?? null,
			});
			return {
				content: [{ type: "text", text: `Created ${task.id}: ${task.title}` }],
				details: task,
			};
		},
	};
}

// ─── update_task ─────────────────────────────────────────────

const UpdateParams = Type.Object({
	id: Type.String({ description: "Task id returned from create_task (e.g. 'task-3')." }),
	status: Type.Optional(
		Type.Union([StatusSchema], {
			description: "New status: pending | in_progress | completed | cancelled.",
		}),
	),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	description: Type.Optional(Type.String()),
	active_form: Type.Optional(Type.String()),
});

export type UpdateTaskParams = Static<typeof UpdateParams>;

export function createUpdateTask(ctx: ToolContext): AgentTool<typeof UpdateParams, Task> {
	return {
		name: "update_task",
		label: "Update task",
		description:
			"Change a task's status or fields. Move tasks to 'in_progress' when you start them and 'completed' when done.",
		parameters: UpdateParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const task = ctx.tasks.update(params.id, {
				status: params.status,
				title: params.title,
				description: params.description,
				activeForm: params.active_form,
			});
			return {
				content: [{ type: "text", text: `${task.id} → ${task.status}: ${task.title}` }],
				details: task,
			};
		},
	};
}

// ─── list_tasks ──────────────────────────────────────────────

const ListParams = Type.Object({
	status: Type.Optional(
		Type.Union([StatusSchema], {
			description: "Filter to one status. Omit to see all tasks.",
		}),
	),
});

export type ListTasksParams = Static<typeof ListParams>;

export interface ListTasksDetails {
	tasks: Task[];
	count: number;
}

export function createListTasks(ctx: ToolContext): AgentTool<typeof ListParams, ListTasksDetails> {
	return {
		name: "list_tasks",
		label: "Tasks",
		description: "List all tasks, optionally filtered by status.",
		parameters: ListParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			const filter: { status?: TaskStatus } = {};
			if (params.status) filter.status = params.status;
			const tasks = ctx.tasks.list(filter);
			const text =
				tasks.length === 0
					? params.status
						? `No tasks with status ${params.status}.`
						: "No tasks."
					: tasks.map(formatLine).join("\n");
			return {
				content: [{ type: "text", text }],
				details: { tasks, count: tasks.length },
			};
		},
	};
}

// ─── get_task ────────────────────────────────────────────────

const GetParams = Type.Object({
	id: Type.String({ description: "Task id." }),
});

export type GetTaskParams = Static<typeof GetParams>;

export function createGetTask(ctx: ToolContext): AgentTool<typeof GetParams, Task> {
	return {
		name: "get_task",
		label: "Get task",
		description: "Fetch a single task by id. Errors if the id is unknown.",
		parameters: GetParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			const task = ctx.tasks.get(params.id);
			if (!task) throw new Error(`Task ${params.id} not found.`);
			return {
				content: [{ type: "text", text: formatLine(task) }],
				details: task,
			};
		},
	};
}

function formatLine(task: Task): string {
	const tag =
		task.status === "in_progress" ? "▶" : task.status === "completed" ? "✓" : task.status === "cancelled" ? "✗" : "○";
	return `${tag} ${task.id} ${task.title}${task.description ? ` — ${task.description}` : ""}`;
}

// ─── factory bundle ──────────────────────────────────────────

export function createTaskTools(ctx: ToolContext): AgentTool<TSchema>[] {
	return [createCreateTask(ctx), createUpdateTask(ctx), createListTasks(ctx), createGetTask(ctx)];
}
