export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
	id: string;
	title: string;
	description: string | null;
	activeForm: string | null;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
}

export interface TaskUpdate {
	title?: string;
	description?: string | null;
	activeForm?: string | null;
	status?: TaskStatus;
}

export type TaskListener = (tasks: Task[]) => void;

/**
 * Per-agent-instance task store. Holds the in-flight checklist the model
 * uses to plan multi-step work. UI listeners receive a snapshot of the
 * full list on every mutation so they can re-render.
 */
export class TaskStore {
	private readonly tasks: Map<string, Task> = new Map();
	private readonly listeners: Set<TaskListener> = new Set();
	private counter = 0;

	create(input: { title: string; description?: string | null; activeForm?: string | null }): Task {
		const id = `task-${++this.counter}`;
		const now = Date.now();
		const task: Task = {
			id,
			title: input.title,
			description: input.description ?? null,
			activeForm: input.activeForm ?? null,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(id, task);
		this.emit();
		return task;
	}

	update(id: string, patch: TaskUpdate): Task {
		const existing = this.tasks.get(id);
		if (!existing) {
			throw new Error(`Task ${id} not found.`);
		}
		const next: Task = {
			...existing,
			title: patch.title ?? existing.title,
			description: patch.description !== undefined ? patch.description : existing.description,
			activeForm: patch.activeForm !== undefined ? patch.activeForm : existing.activeForm,
			status: patch.status ?? existing.status,
			updatedAt: Date.now(),
		};
		this.tasks.set(id, next);
		this.emit();
		return next;
	}

	get(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	list(filter?: { status?: TaskStatus }): Task[] {
		const all = Array.from(this.tasks.values());
		if (filter?.status) return all.filter((t) => t.status === filter.status);
		return all;
	}

	clear(): void {
		this.tasks.clear();
		this.counter = 0;
		this.emit();
	}

	subscribe(listener: TaskListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		const snapshot = this.list();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
