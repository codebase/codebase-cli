import { Container, Text } from "@earendil-works/pi-tui";
import type { Task, TaskStatus, TaskStore } from "../tools/task-store.js";
import { ansi } from "./theme.js";

const STATUS_GLYPH: Record<TaskStatus, string> = {
	in_progress: "▶",
	pending: "○",
	completed: "✓",
	cancelled: "✗",
};

const STATUS_ORDER: Record<TaskStatus, number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
	cancelled: 3,
};

/**
 * Pi-tui port of TaskPanel.tsx — sticky checklist of the agent's open
 * tasks. Mirrors the ink version: hides itself when no non-cancelled
 * tasks exist, sorts in-progress to the top, and uses `activeForm`
 * when supplied so a running task reads "Adding OAuth refresh"
 * instead of the imperative "Add OAuth refresh".
 */
export class TaskPanel extends Container {
	private readonly header: Text;
	private readonly maxVisible: number;
	private unsubscribe: () => void;
	private tasks: readonly Task[] = [];
	private requestRender: () => void;

	constructor(store: TaskStore, requestRender: () => void = () => undefined, maxVisible = 8) {
		super();
		this.maxVisible = maxVisible;
		this.requestRender = requestRender;
		this.header = new Text(ansi.bold(ansi.dim("tasks")), 1, 0);
		this.unsubscribe = store.subscribe((tasks) => this.applyTasks(tasks), { immediate: true });
	}

	/** Re-bind to a fresh TaskStore after a model swap rebuilds the bundle. */
	rebind(store: TaskStore): void {
		this.unsubscribe();
		this.unsubscribe = store.subscribe((tasks) => this.applyTasks(tasks), { immediate: true });
	}

	private applyTasks(tasks: readonly Task[]): void {
		this.tasks = tasks;
		this.rebuild();
		this.requestRender();
	}

	private rebuild(): void {
		const visible = this.tasks.filter((t) => t.status !== "cancelled");
		const children = (this as unknown as { children: unknown[] }).children;
		if (Array.isArray(children)) children.length = 0;
		if (visible.length === 0) {
			this.invalidate();
			return;
		}
		this.addChild(this.header);
		const sorted = [...visible].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
		const shown = sorted.slice(0, this.maxVisible);
		const hidden = sorted.length - shown.length;
		const openTaskIds = new Set(
			visible.filter((task) => task.status !== "completed" && task.status !== "cancelled").map((task) => task.id),
		);
		for (const task of shown) {
			this.addChild(
				new Text(
					renderTaskLine(
						task,
						task.blockedBy.filter((id) => openTaskIds.has(id)),
					),
					1,
					0,
				),
			);
		}
		if (hidden > 0) {
			this.addChild(new Text(ansi.dim(`  …+${hidden} more`), 1, 0));
		}
		this.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
	}
}

function renderTaskLine(task: Task, openBlockers: string[]): string {
	const glyph = STATUS_GLYPH[task.status];
	const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.title;
	const owner = task.owner ? ` @${task.owner}` : "";
	const blocked = openBlockers.length > 0 ? ` blocked by ${openBlockers.join(",")}` : "";
	const blocks = task.blocks.length > 0 ? ` blocks ${task.blocks.join(",")}` : "";
	const text = `${glyph} ${label}${owner}${blocked}${blocks}`;
	const colored =
		openBlockers.length > 0
			? ansi.yellow(text)
			: task.status === "in_progress"
				? ansi.magenta(text)
				: task.status === "completed"
					? ansi.green(text)
					: text;
	return colored;
}
