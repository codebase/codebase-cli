import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { Task, TaskListFilter } from "./task-store.js";
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
	owner: Type.Optional(Type.String({ description: "Agent or person currently claiming this task." })),
	blocked_by: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids that must finish before this task can start.",
		}),
	),
});

export type CreateTaskParams = Static<typeof CreateParams>;

export function createCreateTask(ctx: ToolContext): AgentTool<typeof CreateParams, Task> {
	return {
		name: "create_task",
		label: "New task",
		description:
			"Add a task to the agent's checklist. Returns the task with an assigned id. Status starts as 'pending'. Use owner and blocked_by for multi-agent or dependent work. After creating the checklist, mark exactly one unblocked task in_progress before doing that work.",
		parameters: CreateParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const task = ctx.tasks.create({
				title: params.title,
				description: params.description ?? null,
				activeForm: params.active_form ?? null,
				owner: params.owner ?? null,
				blockedBy: params.blocked_by,
			});
			return {
				content: [
					{
						type: "text",
						text: `Created ${task.id}: ${task.title}.${formatMetaSentence(task)} Keep the checklist live: mark the current unblocked task in_progress before working on it, and complete it immediately after.`,
					},
				],
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
	owner: Type.Optional(Type.String({ description: "Claim or reassign the task to this owner." })),
	clear_owner: Type.Optional(Type.Boolean({ description: "Remove any current owner/claim from the task." })),
	add_blocks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids that this task blocks.",
		}),
	),
	add_blocked_by: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids that block this task.",
		}),
	),
	remove_blocks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids to stop marking as blocked by this task.",
		}),
	),
	remove_blocked_by: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids to stop marking as blockers for this task.",
		}),
	),
});

export type UpdateTaskParams = Static<typeof UpdateParams>;

export function createUpdateTask(ctx: ToolContext): AgentTool<typeof UpdateParams, Task> {
	return {
		name: "update_task",
		label: "Update task",
		description:
			"Change a task's status, owner, or blocker edges. Move each unblocked task to 'in_progress' before starting it and to 'completed' immediately after finishing it. Do not batch lifecycle updates.",
		parameters: UpdateParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const task = ctx.tasks.update(params.id, {
				status: params.status,
				title: params.title,
				description: params.description,
				activeForm: params.active_form,
				owner: params.owner,
				clearOwner: params.clear_owner,
				addBlocks: params.add_blocks,
				addBlockedBy: params.add_blocked_by,
				removeBlocks: params.remove_blocks,
				removeBlockedBy: params.remove_blocked_by,
			});
			const nextStep =
				task.status === "completed"
					? " If more work remains, mark the next task in_progress before starting it."
					: task.status === "in_progress"
						? " Work only this active task until it is complete or blocked."
						: "";
			return {
				content: [
					{
						type: "text",
						text: `${task.id} -> ${task.status}: ${task.title}.${formatMetaSentence(task)}${nextStep}`,
					},
				],
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
	owner: Type.Optional(Type.String({ description: "Filter to tasks claimed by this owner." })),
	available: Type.Optional(
		Type.Boolean({
			description: "When true, show only pending, unowned tasks with no open blockers.",
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
		description: "List tasks, optionally filtered by status, owner, or availability.",
		parameters: ListParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			const filter: TaskListFilter = {};
			if (params.status) filter.status = params.status;
			if (params.owner) filter.owner = params.owner;
			if (params.available) filter.available = true;
			const tasks = ctx.tasks.list(filter);
			const text =
				tasks.length === 0
					? params.available
						? "No available tasks."
						: params.status
							? `No tasks with status ${params.status}.`
							: params.owner
								? `No tasks owned by ${params.owner}.`
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
	const owner = task.owner ? ` @${task.owner}` : "";
	const blockers = task.blockedBy.length > 0 ? ` blocked_by=${task.blockedBy.join(",")}` : "";
	const blocks = task.blocks.length > 0 ? ` blocks=${task.blocks.join(",")}` : "";
	const description = task.description ? ` — ${task.description}` : "";
	return `${tag} ${task.id}${owner} ${task.title}${blockers}${blocks}${description}`;
}

function formatMetaSentence(task: Task): string {
	const owner = task.owner ? ` Owner: ${task.owner}.` : "";
	const blockers = task.blockedBy.length > 0 ? ` Blocked by: ${task.blockedBy.join(", ")}.` : "";
	const blocks = task.blocks.length > 0 ? ` Blocks: ${task.blocks.join(", ")}.` : "";
	return owner || blockers || blocks ? `${owner}${blockers}${blocks}` : "";
}

// ─── factory bundle ──────────────────────────────────────────

export function createTaskTools(ctx: ToolContext): AgentTool<TSchema>[] {
	return [createCreateTask(ctx), createUpdateTask(ctx), createListTasks(ctx), createGetTask(ctx)];
}
