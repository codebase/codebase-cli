import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsStore } from "../auth/credentials.js";
import { NotAuthenticatedError, ProjectClient, ProjectClientError } from "./client.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return handler(url, init);
	}) as unknown as typeof fetch;
}

function makeStore(dataRoot: string, accessToken = "abc", scopes = ["projects", "inference"]): CredentialsStore {
	const store = new CredentialsStore({ dataRoot });
	store.save({
		accessToken,
		scopes,
		source: "codebase",
	});
	return store;
}

describe("ProjectClient.list", () => {
	let dataRoot: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("returns merged convex + storage-only projects, deduped by id", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch((url) => {
			expect(url).toBe("https://codebase.design/api/cli/projects");
			return new Response(
				JSON.stringify({
					projects: [
						{
							id: "p1",
							user_id: "u1",
							title: "Indexed One",
							published_at: "2026-04-01T00:00:00Z",
						},
					],
					s3Projects: ["p1", "p2"],
				}),
				{ status: 200 },
			);
		});
		const client = new ProjectClient({ credentials, fetchFn });
		const list = await client.list();
		expect(list).toHaveLength(2);
		expect(list[0]).toMatchObject({ id: "p1", title: "Indexed One", source: "convex" });
		expect(list[1]).toEqual({ id: "p2", source: "storage-only" });
	});

	it("sends a Bearer token from the credentials store", async () => {
		const credentials = makeStore(dataRoot, "secret-123");
		const fetchFn = mockFetch((_url, init) => {
			const auth = (init?.headers as Record<string, string>)?.Authorization;
			expect(auth).toBe("Bearer secret-123");
			return new Response(JSON.stringify({ projects: [], s3Projects: [] }), { status: 200 });
		});
		await new ProjectClient({ credentials, fetchFn }).list();
	});

	it("throws NotAuthenticatedError when no credentials", async () => {
		const credentials = new CredentialsStore({ dataRoot });
		const fetchFn = mockFetch(() => new Response("nope", { status: 200 }));
		const client = new ProjectClient({ credentials, fetchFn });
		await expect(client.list()).rejects.toThrow(NotAuthenticatedError);
	});

	it("throws NotAuthenticatedError on 401 from server", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch(() => new Response("expired", { status: 401 }));
		const client = new ProjectClient({ credentials, fetchFn });
		await expect(client.list()).rejects.toThrow(NotAuthenticatedError);
	});

	it("throws ProjectClientError on 5xx", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch(() => new Response("oops", { status: 500 }));
		const client = new ProjectClient({ credentials, fetchFn });
		await expect(client.list()).rejects.toThrow(ProjectClientError);
	});
});

describe("ProjectClient.pull", () => {
	let dataRoot: string;
	let workdir: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
		workdir = mkdtempSync(join(tmpdir(), "pulls-"));
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(workdir, { recursive: true, force: true });
	});

	it("streams the response body to disk and returns the size", async () => {
		const credentials = makeStore(dataRoot);
		const payload = Buffer.from("PK\x03\x04fake-zip-bytes");
		const fetchFn = mockFetch((url) => {
			expect(url).toBe("https://codebase.design/api/cli/projects/proj-42/pull");
			const stream = Readable.from(payload);
			return new Response(stream as unknown as ReadableStream<Uint8Array>, {
				status: 200,
				headers: { "content-type": "application/zip" },
			});
		});
		const dest = join(workdir, "out.zip");
		const result = await new ProjectClient({ credentials, fetchFn }).pull("proj-42", dest);
		expect(result.path).toBe(dest);
		expect(result.bytes).toBe(payload.length);
		expect(readFileSync(dest)).toEqual(payload);
	});

	it("URL-encodes the project id", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch((url) => {
			expect(url).toBe("https://codebase.design/api/cli/projects/has%2Fslash/pull");
			return new Response(Readable.from(Buffer.from("z")) as unknown as ReadableStream<Uint8Array>, {
				status: 200,
			});
		});
		await new ProjectClient({ credentials, fetchFn }).pull("has/slash", join(workdir, "x.zip"));
	});

	it("throws ProjectClientError(404) for missing projects", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch(() => new Response("not found", { status: 404 }));
		const client = new ProjectClient({ credentials, fetchFn });
		await expect(client.pull("missing", join(workdir, "x.zip"))).rejects.toThrow(/project not found/);
	});
});

describe("ProjectClient build endpoints", () => {
	let dataRoot: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("starts a web build with OAuth bearer auth", async () => {
		const credentials = makeStore(dataRoot, "build-token", ["projects", "inference", "builds:read", "builds:write"]);
		const fetchFn = mockFetch((url, init) => {
			expect(url).toBe("https://codebase.design/api/v1/builds");
			expect(init?.method).toBe("POST");
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer build-token");
			expect(JSON.parse(String(init?.body))).toEqual({
				prompt: "Build the dashboard",
				model: "codebase/d4f",
				projectId: "proj-1",
			});
			return new Response(
				JSON.stringify({
					sessionId: "sess-1",
					projectId: "proj-1",
					status: "building",
					model: "codebase/d4f",
					poll: "/api/v1/builds/sess-1/status",
				}),
				{ status: 202 },
			);
		});

		const result = await new ProjectClient({ credentials, fetchFn }).startBuild({
			prompt: "Build the dashboard",
			model: "codebase/d4f",
			projectId: "proj-1",
		});

		expect(result).toMatchObject({ sessionId: "sess-1", projectId: "proj-1", status: "building" });
	});

	it("rejects web build start before network when OAuth token lacks build scopes", async () => {
		const credentials = makeStore(dataRoot, "old-token", ["projects", "inference", "credits"]);
		const fetchFn = vi.fn(async () => new Response("should not be called")) as unknown as typeof fetch;
		const client = new ProjectClient({ credentials, fetchFn });

		await expect(client.startBuild({ prompt: "Ship it" })).rejects.toMatchObject({
			name: "ProjectClientError",
			status: 403,
			message: expect.stringContaining("missing build scopes: builds:read builds:write"),
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("reads build status, preview, and cancel endpoints", async () => {
		const credentials = makeStore(dataRoot);
		const seen: string[] = [];
		const fetchFn = mockFetch((url, init) => {
			seen.push(`${init?.method ?? "GET"} ${url}`);
			if (url.endsWith("/status")) {
				return new Response(JSON.stringify({ sessionId: "sess/1", status: "completed", projectId: "proj" }));
			}
			if (url.endsWith("/preview")) {
				return new Response(JSON.stringify({ ok: true, previewPath: "/preview/proj" }));
			}
			if (url.endsWith("/cancel")) {
				return new Response(JSON.stringify({ sessionId: "sess/1", status: "cancelled", stopped: true }));
			}
			return new Response("missing", { status: 404 });
		});
		const client = new ProjectClient({ credentials, fetchFn });

		await expect(client.getBuildStatus("sess/1")).resolves.toMatchObject({ status: "completed" });
		await expect(client.ensureBuildPreview("sess/1")).resolves.toMatchObject({ previewPath: "/preview/proj" });
		await expect(client.cancelBuild("sess/1")).resolves.toMatchObject({ stopped: true });
		expect(seen).toEqual([
			"GET https://codebase.design/api/v1/builds/sess%2F1/status",
			"POST https://codebase.design/api/v1/builds/sess%2F1/preview",
			"POST https://codebase.design/api/v1/builds/sess%2F1/cancel",
		]);
	});

	it("surfaces missing build scopes as a ProjectClientError", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch(
			() => new Response(JSON.stringify({ error: "Missing required scope: builds:write" }), { status: 403 }),
		);
		const client = new ProjectClient({ credentials, fetchFn });

		await expect(client.startBuild({ prompt: "Ship it" })).rejects.toMatchObject({
			name: "ProjectClientError",
			status: 403,
		});
	});

	it("surfaces Retry-After from rate-limited build responses", async () => {
		const credentials = makeStore(dataRoot);
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ error: "rate_limited", error_description: "Too many requests" }), {
					status: 429,
					headers: { "retry-after": "28" },
				}),
		);
		const client = new ProjectClient({ credentials, fetchFn });

		await expect(client.getBuildStatus("sess-1")).rejects.toMatchObject({
			name: "ProjectClientError",
			status: 429,
			retryAfterMs: 28_000,
		});
	});
});

describe("ProjectClient.hasCredentials", () => {
	it("returns true when a non-expired credential exists", () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
		try {
			makeStore(dataRoot);
			const client = new ProjectClient({ credentials: new CredentialsStore({ dataRoot }) });
			expect(client.hasCredentials()).toBe(true);
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});

	it("returns false when no credential file exists", () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
		try {
			const client = new ProjectClient({ credentials: new CredentialsStore({ dataRoot }) });
			expect(client.hasCredentials()).toBe(false);
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});

	it("returns true for an expired OAuth credential with a refresh token", () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "projects-"));
		try {
			const credentials = new CredentialsStore({ dataRoot });
			credentials.save({
				accessToken: "expired",
				refreshToken: "refresh",
				expiresAt: Date.now() - 60_000,
				scopes: ["projects"],
				source: "codebase",
			});
			const client = new ProjectClient({ credentials });
			expect(client.hasCredentials()).toBe(true);
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});
});
