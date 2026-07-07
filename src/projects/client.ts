import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defaultOAuthConfig } from "../auth/cli.js";
import { CredentialsStore } from "../auth/credentials.js";
import type { OAuthConfig } from "../auth/flow.js";
import { webBuildScopeReadiness } from "../auth/scopes.js";
import { TokenManager } from "../auth/token-manager.js";
import type {
	BuildCancelResponse,
	BuildPreviewResponse,
	BuildStartResponse,
	BuildStatusResponse,
	ListProjectsResponse,
	PlatformProject,
} from "./types.js";

const DEFAULT_BASE = "https://codebase.design";

export interface ProjectClientOptions {
	/** Override the auth-base for tests. Default: codebase.design. */
	baseUrl?: string;
	/** Override the credentials source for tests. */
	credentials?: CredentialsStore;
	/** Override OAuth refresh config for tests/local web. */
	oauthConfig?: OAuthConfig;
	/** Override fetch for tests. */
	fetchFn?: typeof fetch;
}

export class NotAuthenticatedError extends Error {
	constructor(message?: string) {
		super(
			message ??
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
 * scopes.
 */
export class ProjectClient {
	private readonly baseUrl: string;
	private readonly credStore: CredentialsStore;
	private readonly tokenManager: TokenManager;
	private readonly fetchFn: typeof fetch;

	constructor(opts: ProjectClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
		this.credStore = opts.credentials ?? new CredentialsStore();
		this.tokenManager = new TokenManager({
			store: this.credStore,
			oauthConfig: opts.oauthConfig ?? defaultOAuthConfig(),
		});
		this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
	}

	absoluteUrl(path: string): string {
		if (/^https?:\/\//.test(path)) return path;
		return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
	}

	/**
	 * List the user's projects. Merges the Convex-sourced list with
	 * raw storage-only entries the backend reports separately, so the
	 * CLI sees both indexed-and-published projects and any work-in-
	 * progress trees that haven't been published yet.
	 */
	async list(): Promise<readonly PlatformProject[]> {
		const token = await this.requireToken();
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
		const token = await this.requireToken();
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

	async startBuild(input: {
		prompt: string;
		model?: string;
		scaffold?: string;
		projectId?: string;
	}): Promise<BuildStartResponse> {
		this.requireWebBuildScopes("start a web build");
		return await this.postJson<BuildStartResponse>("/api/v1/builds", {
			prompt: input.prompt,
			model: input.model,
			scaffold: input.scaffold,
			projectId: input.projectId,
		});
	}

	async getBuildStatus(sessionId: string): Promise<BuildStatusResponse> {
		return await this.getJson<BuildStatusResponse>(`/api/v1/builds/${encodeURIComponent(sessionId)}/status`);
	}

	async ensureBuildPreview(sessionId: string): Promise<BuildPreviewResponse> {
		return await this.postJson<BuildPreviewResponse>(`/api/v1/builds/${encodeURIComponent(sessionId)}/preview`, {});
	}

	async cancelBuild(sessionId: string): Promise<BuildCancelResponse> {
		return await this.postJson<BuildCancelResponse>(`/api/v1/builds/${encodeURIComponent(sessionId)}/cancel`, {});
	}

	/**
	 * Convenience: returns the loaded credential, or null if none.
	 * Useful for slash commands that want to gracefully degrade
	 * instead of throwing.
	 */
	hasCredentials(): boolean {
		const creds = this.credStore.load();
		if (!creds) return false;
		if (!this.credStore.isExpired(creds)) return true;
		return creds.source === "codebase" && !!creds.refreshToken;
	}

	private async getJson<T>(path: string): Promise<T> {
		const token = await this.requireToken();
		const res = await this.fetchFn(this.absoluteUrl(path), {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		});
		return await this.readJsonResponse<T>(res, "request");
	}

	private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
		const token = await this.requireToken();
		const res = await this.fetchFn(this.absoluteUrl(path), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(omitUndefined(body)),
		});
		return await this.readJsonResponse<T>(res, "request");
	}

	private async readJsonResponse<T>(res: Response, action: string): Promise<T> {
		if (res.status === 401) throw new NotAuthenticatedError();
		if (!res.ok) {
			throw new ProjectClientError(
				`${action} failed: ${res.status} ${await responseMessage(res)}`.trim(),
				res.status,
			);
		}
		return (await res.json()) as T;
	}

	private async requireToken(): Promise<string> {
		const creds = this.credStore.load();
		if (!creds) throw new NotAuthenticatedError();
		try {
			return await this.tokenManager.getAccessToken();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/auth login|not signed in|expired/i.test(message)) {
				throw new NotAuthenticatedError(message);
			}
			throw new ProjectClientError(`could not refresh codebase.design credentials: ${message}`);
		}
	}

	private requireWebBuildScopes(action: string): void {
		const creds = this.credStore.load();
		if (!creds) throw new NotAuthenticatedError();
		const readiness = webBuildScopeReadiness(creds);
		if (readiness.status === "ready") return;
		throw new ProjectClientError(`cannot ${action}: ${readiness.message}. ${readiness.fix}`, 403);
	}
}

function omitUndefined(body: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

async function responseMessage(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	if (!text) return res.statusText;
	try {
		const json = JSON.parse(text) as { error?: unknown; error_description?: unknown };
		return [json.error, json.error_description].filter((value) => typeof value === "string").join(" — ");
	} catch {
		return text.slice(0, 300);
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
