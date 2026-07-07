import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
	id: string;
	title: string;
	description: string | null;
	activeForm: string | null;
	status: TaskStatus;
	owner: string | null;
	blocks: string[];
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
}

export interface TaskUpdate {
	title?: string;
	description?: string | null;
	activeForm?: string | null;
	status?: TaskStatus;
	owner?: string | null;
	clearOwner?: boolean;
	addBlocks?: string[];
	addBlockedBy?: string[];
	removeBlocks?: string[];
	removeBlockedBy?: string[];
}

export interface TaskListFilter {
	status?: TaskStatus;
	owner?: string;
	available?: boolean;
}

export interface TaskStoreOptions {
	cwd?: string;
	taskListId?: string;
	dataRoot?: string;
	watch?: boolean;
}

export type TaskListener = (tasks: Task[]) => void;

export interface TaskSubscribeOptions {
	immediate?: boolean;
}

/**
 * Agent checklist store. Defaults to in-memory for tests and small tool
 * contexts; when bound to a cwd + taskListId it persists one JSON file per
 * task under the Codebase data directory and watches for external edits.
 */
export class TaskStore {
	private readonly tasks: Map<string, Task> = new Map();
	private readonly listeners: Set<TaskListener> = new Set();
	private readonly dir: string | null;
	private watcher: FSWatcher | null = null;
	private reloadTimer: NodeJS.Timeout | null = null;
	private counter = 0;

	constructor(options: TaskStoreOptions = {}) {
		if (options.cwd && options.taskListId) {
			const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
			const projectHash = createHash("sha256").update(options.cwd).digest("hex").slice(0, 8);
			this.dir = join(dataRoot, "tasks", projectHash, sanitizePathPart(options.taskListId));
			this.loadFromDisk();
			if (options.watch !== false) this.startWatching();
		} else {
			this.dir = null;
		}
	}

	create(input: {
		title: string;
		description?: string | null;
		activeForm?: string | null;
		owner?: string | null;
		blockedBy?: string[];
	}): Task {
		const nextCounter = this.counter + 1;
		const id = `task-${nextCounter}`;
		const now = Date.now();
		const blockedBy = cleanTaskIds(input.blockedBy).filter((blockedById) => blockedById !== id);
		for (const blockerId of blockedBy) this.mustGet(blockerId);
		this.counter = nextCounter;
		const task: Task = {
			id,
			title: input.title,
			description: input.description ?? null,
			activeForm: input.activeForm ?? null,
			status: "pending",
			owner: cleanOwner(input.owner),
			blocks: [],
			blockedBy,
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(id, task);
		const touched = new Set<string>([id]);
		for (const blockerId of task.blockedBy) {
			const blocker = this.tasks.get(blockerId);
			if (!blocker) continue;
			this.tasks.set(blockerId, { ...blocker, blocks: uniq([...blocker.blocks, id]), updatedAt: now });
			touched.add(blockerId);
		}
		this.persistTouched(touched);
		this.emit();
		return task;
	}

	update(id: string, patch: TaskUpdate): Task {
		const existing = this.tasks.get(id);
		if (!existing) {
			throw new Error(`Task ${id} not found.`);
		}
		const now = Date.now();
		let next: Task = {
			...existing,
			title: patch.title ?? existing.title,
			description: patch.description !== undefined ? patch.description : existing.description,
			activeForm: patch.activeForm !== undefined ? patch.activeForm : existing.activeForm,
			status: patch.status ?? existing.status,
			owner: patch.clearOwner ? null : patch.owner !== undefined ? cleanOwner(patch.owner) : existing.owner,
			updatedAt: now,
		};
		const touched = new Set<string>([id]);

		for (const blockerId of cleanTaskIds(patch.addBlockedBy)) {
			if (blockerId === id) continue;
			const blocker = this.mustGet(blockerId);
			this.assertCanBlock(blockerId, id);
			next = { ...next, blockedBy: uniq([...next.blockedBy, blockerId]) };
			this.tasks.set(blockerId, { ...blocker, blocks: uniq([...blocker.blocks, id]), updatedAt: now });
			touched.add(blockerId);
		}
		for (const blockedId of cleanTaskIds(patch.addBlocks)) {
			if (blockedId === id) continue;
			const blocked = this.mustGet(blockedId);
			this.assertCanBlock(id, blockedId);
			next = { ...next, blocks: uniq([...next.blocks, blockedId]) };
			this.tasks.set(blockedId, { ...blocked, blockedBy: uniq([...blocked.blockedBy, id]), updatedAt: now });
			touched.add(blockedId);
		}
		for (const blockerId of cleanTaskIds(patch.removeBlockedBy)) {
			const blocker = this.tasks.get(blockerId);
			next = { ...next, blockedBy: next.blockedBy.filter((value) => value !== blockerId) };
			if (blocker) {
				this.tasks.set(blockerId, {
					...blocker,
					blocks: blocker.blocks.filter((value) => value !== id),
					updatedAt: now,
				});
				touched.add(blockerId);
			}
		}
		for (const blockedId of cleanTaskIds(patch.removeBlocks)) {
			const blocked = this.tasks.get(blockedId);
			next = { ...next, blocks: next.blocks.filter((value) => value !== blockedId) };
			if (blocked) {
				this.tasks.set(blockedId, {
					...blocked,
					blockedBy: blocked.blockedBy.filter((value) => value !== id),
					updatedAt: now,
				});
				touched.add(blockedId);
			}
		}
		if (next.status === "in_progress" && this.openBlockers(next).length > 0) {
			const blockers = this.openBlockers(next);
			throw new Error(`Task ${id} is blocked by ${blockers.join(", ")}.`);
		}

		this.tasks.set(id, next);
		this.persistTouched(touched);
		this.emit();
		return next;
	}

	get(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	list(filter?: TaskListFilter): Task[] {
		let all = this.snapshot();
		if (filter?.status) all = all.filter((t) => t.status === filter.status);
		if (filter?.owner) all = all.filter((t) => t.owner === filter.owner);
		if (filter?.available)
			all = all.filter((t) => t.status === "pending" && !t.owner && this.openBlockers(t).length === 0);
		return all;
	}

	clear(): void {
		this.tasks.clear();
		this.counter = 0;
		if (this.dir && existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
		this.emit();
	}

	subscribe(listener: TaskListener, options: TaskSubscribeOptions = {}): () => void {
		this.listeners.add(listener);
		if (options.immediate) listener(this.list());
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.watcher?.close();
		this.watcher = null;
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = null;
	}

	private mustGet(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task ${id} not found.`);
		return task;
	}

	private assertCanBlock(blockerId: string, blockedId: string): void {
		if (this.canReach(blockedId, blockerId)) {
			throw new Error(`Task dependency cycle: ${blockerId} cannot block ${blockedId}.`);
		}
	}

	private canReach(fromId: string, toId: string): boolean {
		const seen = new Set<string>();
		const stack = [fromId];
		while (stack.length > 0) {
			const id = stack.pop();
			if (!id || seen.has(id)) continue;
			if (id === toId) return true;
			seen.add(id);
			const task = this.tasks.get(id);
			if (!task) continue;
			for (const blockedId of task.blocks) stack.push(blockedId);
		}
		return false;
	}

	private openBlockers(task: Task): string[] {
		return task.blockedBy.filter((id) => {
			const blocker = this.tasks.get(id);
			return blocker && blocker.status !== "completed" && blocker.status !== "cancelled";
		});
	}

	private snapshot(): Task[] {
		return Array.from(this.tasks.values()).sort((a, b) => {
			if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
			return taskNumber(a.id) - taskNumber(b.id);
		});
	}

	private emit(): void {
		const snapshot = this.list();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	private startWatching(): void {
		if (!this.dir) return;
		mkdirSync(this.dir, { recursive: true });
		try {
			this.watcher = watch(this.dir, { persistent: false }, () => {
				if (this.reloadTimer) clearTimeout(this.reloadTimer);
				this.reloadTimer = setTimeout(() => {
					this.reloadTimer = null;
					this.loadFromDisk();
					this.emit();
				}, 50);
				this.reloadTimer.unref?.();
			});
			this.watcher.unref?.();
		} catch {
			this.watcher = null;
		}
	}

	private loadFromDisk(): void {
		if (!this.dir) return;
		const loaded = new Map<string, Task>();
		let maxCounter = 0;
		let files: string[];
		try {
			files = readdirSync(this.dir).filter((file) => file.endsWith(".json"));
		} catch {
			this.tasks.clear();
			this.counter = 0;
			return;
		}
		for (const file of files) {
			try {
				const task = normalizeTask(JSON.parse(readFileSync(join(this.dir, file), "utf8")));
				if (!task) continue;
				loaded.set(task.id, task);
				maxCounter = Math.max(maxCounter, taskNumber(task.id));
			} catch {}
		}
		reconcileTaskGraph(loaded);
		this.tasks.clear();
		for (const task of loaded.values()) this.tasks.set(task.id, task);
		this.counter = maxCounter;
	}

	private persistTouched(ids: ReadonlySet<string>): void {
		if (!this.dir) return;
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (task) this.writeTask(task);
		}
	}

	private writeTask(task: Task): void {
		if (!this.dir) return;
		mkdirSync(this.dir, { recursive: true });
		const path = join(this.dir, `${sanitizePathPart(task.id)}.json`);
		const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, path);
		} catch (err) {
			tryUnlink(tmp);
			throw err;
		}
	}
}

function normalizeTask(value: unknown): Task | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	if (typeof input.id !== "string" || typeof input.title !== "string") return null;
	const now = Date.now();
	const status = isTaskStatus(input.status) ? input.status : "pending";
	return {
		id: input.id,
		title: input.title,
		description: typeof input.description === "string" ? input.description : null,
		activeForm: typeof input.activeForm === "string" ? input.activeForm : null,
		status,
		owner: cleanOwner(input.owner),
		blocks: cleanTaskIds(input.blocks),
		blockedBy: cleanTaskIds(input.blockedBy),
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
	};
}

function reconcileTaskGraph(tasks: Map<string, Task>): void {
	for (const [id, task] of tasks) {
		tasks.set(id, {
			...task,
			blocks: cleanKnownTaskIds(task.blocks, tasks, id),
			blockedBy: cleanKnownTaskIds(task.blockedBy, tasks, id),
		});
	}
	for (const [id, task] of tasks) {
		for (const blockedId of task.blocks) {
			const blocked = tasks.get(blockedId);
			if (!blocked) continue;
			tasks.set(blockedId, { ...blocked, blockedBy: uniq([...blocked.blockedBy, id]) });
		}
		for (const blockerId of task.blockedBy) {
			const blocker = tasks.get(blockerId);
			if (!blocker) continue;
			tasks.set(blockerId, { ...blocker, blocks: uniq([...blocker.blocks, id]) });
		}
	}
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function cleanOwner(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function cleanTaskIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return uniq(
		value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

function cleanKnownTaskIds(value: string[], tasks: ReadonlyMap<string, Task>, selfId: string): string[] {
	return uniq(value.filter((id) => id !== selfId && tasks.has(id)));
}

function uniq(values: string[]): string[] {
	return Array.from(new Set(values));
}

function taskNumber(id: string): number {
	const match = /^task-(\d+)$/.exec(id);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sanitizePathPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "default";
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// best effort cleanup
	}
}
