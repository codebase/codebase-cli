import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BUILD_HANDOFF_VERSION = 1;

export interface BuildHandoff {
	version: number;
	cwd: string;
	sessionId: string;
	projectId: string;
	status: string;
	model?: string;
	scaffold?: string;
	promptPreview?: string;
	previewUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface BuildHandoffStoreOptions {
	cwd?: string;
	dataRoot?: string;
}

/**
 * Per-cwd pointer to the latest accepted web build. This is runtime
 * continuity state, not user config: it lets `project status latest`
 * recover after a terminal closes without storing tokens or full prompts.
 */
export class BuildHandoffStore {
	private readonly cwd: string;
	private readonly path: string;

	constructor(options: BuildHandoffStoreOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		const hash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 8);
		this.path = join(dataRoot, "projects", hash, "web-builds", "latest.json");
	}

	get filePath(): string {
		return this.path;
	}

	load(): BuildHandoff | null {
		if (!existsSync(this.path)) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			return null;
		}
		if (!isHandoff(parsed)) return null;
		if (parsed.cwd !== this.cwd) return null;
		return parsed;
	}

	save(input: {
		sessionId: string;
		projectId: string;
		status: string;
		model?: string;
		scaffold?: string;
		prompt?: string;
		previewUrl?: string;
	}): BuildHandoff {
		const now = new Date().toISOString();
		const existing = this.load();
		const sameSession = existing?.sessionId === input.sessionId;
		const payload: BuildHandoff = {
			version: BUILD_HANDOFF_VERSION,
			cwd: this.cwd,
			sessionId: input.sessionId,
			projectId: input.projectId,
			status: input.status,
			model: input.model,
			scaffold: input.scaffold,
			promptPreview: input.prompt
				? truncate(input.prompt.trim().replace(/\s+/g, " "), 160)
				: sameSession
					? existing?.promptPreview
					: undefined,
			previewUrl: input.previewUrl ?? (sameSession ? existing?.previewUrl : undefined),
			createdAt: sameSession ? existing.createdAt : now,
			updatedAt: now,
		};
		this.writeAtomic(payload);
		return payload;
	}

	update(
		input: Partial<Pick<BuildHandoff, "status" | "model" | "previewUrl">> & { sessionId: string },
	): BuildHandoff | null {
		const existing = this.load();
		if (!existing || existing.sessionId !== input.sessionId) return null;
		const payload: BuildHandoff = {
			...existing,
			...withoutUndefined({
				status: input.status,
				model: input.model,
				previewUrl: input.previewUrl,
			}),
			updatedAt: new Date().toISOString(),
		};
		this.writeAtomic(payload);
		return payload;
	}

	private writeAtomic(payload: BuildHandoff): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.path);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				// best effort
			}
			throw err;
		}
	}
}

function isHandoff(value: unknown): value is BuildHandoff {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === BUILD_HANDOFF_VERSION &&
		typeof record.cwd === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.projectId === "string" &&
		typeof record.status === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string"
	);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
