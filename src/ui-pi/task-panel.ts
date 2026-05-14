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

	constructor(store: TaskStore, maxVisible = 8) {
		super();
		this.maxVisible = maxVisible;
		this.header = new Text(ansi.bold(ansi.dim("tasks")), 1, 0);
		this.unsubscribe = store.subscribe((tasks) => this.applyTasks(tasks));
	}

	/** Re-bind to a fresh TaskStore after a model swap rebuilds the bundle. */
	rebind(store: TaskStore): void {
		this.unsubscribe();
		this.unsubscribe = store.subscribe((tasks) => this.applyTasks(tasks));
	}

	private applyTasks(tasks: readonly Task[]): void {
		this.tasks = tasks;
		this.rebuild();
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
		for (const task of shown) {
			this.addChild(new Text(renderTaskLine(task), 1, 0));
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

function renderTaskLine(task: Task): string {
	const glyph = STATUS_GLYPH[task.status];
	const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.title;
	const colored =
		task.status === "in_progress"
			? ansi.magenta(`${glyph} ${label}`)
			: task.status === "completed"
				? ansi.green(`${glyph} ${label}`)
				: `${glyph} ${label}`;
	return colored;
}
