import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CredentialsStore } from "../auth/credentials.js";
import type { ListProjectsResponse, PlatformProject } from "./types.js";

const DEFAULT_BASE = "https://codebase.design";

export interface ProjectClientOptions {
	/** Override the auth-base for tests. Default: codebase.design. */
	baseUrl?: string;
	/** Override the credentials source for tests. */
	credentials?: CredentialsStore;
	/** Override fetch for tests. */
	fetchFn?: typeof fetch;
}

export class NotAuthenticatedError extends Error {
	constructor() {
		super(
			"not signed in to codebase.design. Run `codebase auth login`, or use BYOK by setting an *_API_KEY env var.",
		);
		this.name = "NotAuthenticatedError";
	}
}

export class ProjectClientError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "ProjectClientError";
	}
}

/**
 * Read-only client for the `/cli/projects` endpoints on
 * codebase.design. Both endpoints require the `projects` scope on
 * the access token — already requested by the OAuth flow's default
 * scopes (`inference projects credits`).
 */
export class ProjectClient {
	private readonly baseUrl: string;
	private readonly credStore: CredentialsStore;
	private readonly fetchFn: typeof fetch;

	constructor(opts: ProjectClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
		this.credStore = opts.credentials ?? new CredentialsStore();
		this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
	}

	/**
	 * List the user's projects. Merges the Convex-sourced list with
	 * raw storage-only entries the backend reports separately, so the
	 * CLI sees both indexed-and-published projects and any work-in-
	 * progress trees that haven't been published yet.
	 */
	async list(): Promise<readonly PlatformProject[]> {
		const token = this.requireToken();
		const res = await this.fetchFn(`${this.baseUrl}/api/cli/projects`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.status === 401) throw new NotAuthenticatedError();
		if (!res.ok) {
			throw new ProjectClientError(
				`list projects failed: ${res.status} ${await res.text().catch(() => "")}`.trim(),
				res.status,
			);
		}
		const body = (await res.json()) as ListProjectsResponse & {
			s3Projects?: readonly string[];
		};
		const indexed: PlatformProject[] = (body.projects ?? []).map((p) => ({
			...p,
			source: "convex" as const,
		}));
		const indexedIds = new Set(indexed.map((p) => p.id));
		const storageOnly: PlatformProject[] = [];
		for (const id of body.s3Projects ?? []) {
			if (indexedIds.has(id)) continue;
			storageOnly.push({ id, source: "storage-only" });
		}
		return [...indexed, ...storageOnly];
	}

	/**
	 * Download a project as a ZIP and stream-write it to `destPath`
	 * (or `~/.codebase/pulls/<id>.zip` if not given). Returns the path
	 * the bytes were written to plus the file size on disk so the
	 * caller can surface it.
	 */
	async pull(projectId: string, destPath?: string): Promise<{ path: string; bytes: number }> {
		const token = this.requireToken();
		const res = await this.fetchFn(`${this.baseUrl}/api/cli/projects/${encodeURIComponent(projectId)}/pull`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.status === 401) throw new NotAuthenticatedError();
		if (res.status === 404) {
			throw new ProjectClientError(`project not found: ${projectId}`, 404);
		}
		if (!res.ok) {
			throw new ProjectClientError(
				`pull failed: ${res.status} ${await res.text().catch(() => "")}`.trim(),
				res.status,
			);
		}
		const finalPath = destPath ?? defaultPullPath(projectId);
		mkdirSync(dirname(finalPath), { recursive: true });
		if (!res.body) {
			throw new ProjectClientError("pull response had no body", res.status);
		}
		await pipeline(Readable.fromWeb(res.body as never), createWriteStream(finalPath));
		const bytes = statSync(finalPath).size;
		return { path: finalPath, bytes };
	}

	/**
	 * Convenience: returns the loaded credential, or null if none.
	 * Useful for slash commands that want to gracefully degrade
	 * instead of throwing.
	 */
	hasCredentials(): boolean {
		const creds = this.credStore.load();
		return !!creds && !this.credStore.isExpired(creds);
	}

	private requireToken(): string {
		const creds = this.credStore.load();
		if (!creds || this.credStore.isExpired(creds)) {
			throw new NotAuthenticatedError();
		}
		return creds.accessToken;
	}
}

function defaultPullPath(projectId: string): string {
	const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(homedir(), ".codebase", "pulls", `${safe}.zip`);
}

/** Re-export so callers can pre-check the destination path. */
export function defaultDownloadPath(projectId: string): string {
	return defaultPullPath(projectId);
}
