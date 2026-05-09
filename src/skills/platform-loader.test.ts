import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsStore } from "../auth/credentials.js";
import { PlatformLoader } from "./platform-loader.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return handler(url, init);
	}) as unknown as typeof fetch;
}

function makeAuthedStore(dataRoot: string): CredentialsStore {
	const store = new CredentialsStore({ dataRoot });
	store.save({
		accessToken: "tok",
		scopes: ["projects", "inference"],
		source: "codebase",
	});
	return store;
}

function loaderFactory(opts: {
	credentials: CredentialsStore;
	cachePath: string;
	fetchFn: typeof fetch;
	now?: () => number;
	ttlMs?: number;
}) {
	return new PlatformLoader({
		credentials: opts.credentials,
		cachePath: opts.cachePath,
		fetchFn: opts.fetchFn,
		now: opts.now,
		ttlMs: opts.ttlMs,
	});
}

describe("PlatformLoader", () => {
	let dataRoot: string;
	let cachePath: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "platform-loader-"));
		cachePath = join(dataRoot, "cache.json");
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("returns [] without a network call when not signed in", async () => {
		const fetchFn = mockFetch(() => {
			throw new Error("should not fetch");
		});
		const loader = loaderFactory({
			credentials: new CredentialsStore({ dataRoot }),
			cachePath,
			fetchFn,
		});
		expect(await loader.listSkills()).toEqual([]);
		expect(await loader.listTemplates()).toEqual([]);
		expect(await loader.listPrompts()).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("fetches assets and tags them with source: platform", async () => {
		const fetchFn = mockFetch(() => {
			return new Response(
				JSON.stringify({
					skills: [{ id: "optimize", name: "Optimize", description: "Make it fast", systemPrompt: "Be fast." }],
					templates: [{ id: "next-app", name: "Next App", description: "scaffold", body: "..." }],
					prompts: [{ id: "fix-it", name: "Fix It", description: "...", body: "go" }],
				}),
				{ status: 200, headers: { ETag: '"v1"' } },
			);
		});
		const loader = loaderFactory({ credentials: makeAuthedStore(dataRoot), cachePath, fetchFn });

		const skills = await loader.listSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ id: "optimize", kind: "skill", source: "platform" });

		const templates = await loader.listTemplates();
		expect(templates[0]).toMatchObject({ id: "next-app", kind: "template", source: "platform" });

		const prompts = await loader.listPrompts();
		expect(prompts[0]).toMatchObject({ id: "fix-it", kind: "prompt", source: "platform" });
	});

	it("coalesces concurrent list calls into a single fetch", async () => {
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ skills: [], templates: [], prompts: [] }), {
					status: 200,
				}),
		);
		const loader = loaderFactory({ credentials: makeAuthedStore(dataRoot), cachePath, fetchFn });
		await Promise.all([loader.listSkills(), loader.listTemplates(), loader.listPrompts()]);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("caches the response and serves from cache within TTL", async () => {
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ skills: [{ id: "x", name: "X", description: "", systemPrompt: "" }] }), {
					status: 200,
				}),
		);
		const loader = loaderFactory({
			credentials: makeAuthedStore(dataRoot),
			cachePath,
			fetchFn,
			ttlMs: 60_000,
			now: () => 1000,
		});
		await loader.listSkills();
		await loader.listSkills();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Cache is on disk
		expect(existsSync(cachePath)).toBe(true);
		const cached = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cached.body.skills).toHaveLength(1);
	});

	it("re-fetches once TTL elapses", async () => {
		const responses = [
			new Response(JSON.stringify({ skills: [{ id: "v1", name: "V1", description: "", systemPrompt: "" }] }), {
				status: 200,
			}),
			new Response(JSON.stringify({ skills: [{ id: "v2", name: "V2", description: "", systemPrompt: "" }] }), {
				status: 200,
			}),
		];
		const fetchFn = mockFetch(() => {
			const r = responses.shift();
			if (!r) throw new Error("unexpected fetch");
			return r;
		});
		let now = 1000;
		const loader = loaderFactory({
			credentials: makeAuthedStore(dataRoot),
			cachePath,
			fetchFn,
			ttlMs: 60_000,
			now: () => now,
		});
		const first = await loader.listSkills();
		expect(first[0].id).toBe("v1");

		now += 60_001; // past TTL
		const second = await loader.listSkills();
		expect(second[0].id).toBe("v2");
	});

	it("treats 304 as a cache refresh", async () => {
		// Seed cache.
		const existing = {
			fetchedAt: 0,
			etag: '"v1"',
			body: { skills: [{ id: "cached", name: "Cached", description: "", systemPrompt: "" }] },
		};
		require("node:fs").writeFileSync(cachePath, JSON.stringify(existing));

		const fetchFn = mockFetch((_url, init) => {
			const ifNoneMatch = (init?.headers as Record<string, string>)?.["If-None-Match"];
			expect(ifNoneMatch).toBe('"v1"');
			return new Response(null, { status: 304 });
		});

		const loader = loaderFactory({
			credentials: makeAuthedStore(dataRoot),
			cachePath,
			fetchFn,
			ttlMs: 1, // force re-fetch
			now: () => 100_000,
		});

		const skills = await loader.listSkills();
		expect(skills[0].id).toBe("cached");

		// Cache timestamp was bumped.
		const after = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(after.fetchedAt).toBe(100_000);
		expect(after.etag).toBe('"v1"');
	});

	it("treats 404 as an empty bundle (endpoint TBD)", async () => {
		const fetchFn = mockFetch(() => new Response("not found", { status: 404 }));
		const loader = loaderFactory({ credentials: makeAuthedStore(dataRoot), cachePath, fetchFn });
		expect(await loader.listSkills()).toEqual([]);
		expect(await loader.listTemplates()).toEqual([]);
		expect(await loader.listPrompts()).toEqual([]);
		// And it should be cached so the next call doesn't refetch.
		expect(existsSync(cachePath)).toBe(true);
	});

	it("falls back to cache on network failure", async () => {
		const seeded = {
			fetchedAt: 0,
			body: { skills: [{ id: "stale", name: "S", description: "", systemPrompt: "" }] },
		};
		require("node:fs").writeFileSync(cachePath, JSON.stringify(seeded));

		const fetchFn = mockFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const loader = loaderFactory({
			credentials: makeAuthedStore(dataRoot),
			cachePath,
			fetchFn,
			ttlMs: 1,
			now: () => 100_000,
		});
		const skills = await loader.listSkills();
		expect(skills[0].id).toBe("stale");
	});

	it("never throws, even when everything is broken", async () => {
		const fetchFn = mockFetch(() => {
			throw new Error("boom");
		});
		const loader = loaderFactory({ credentials: makeAuthedStore(dataRoot), cachePath, fetchFn });
		// No cache, no network → empty arrays, no throw.
		expect(await loader.listSkills()).toEqual([]);
		expect(await loader.listTemplates()).toEqual([]);
		expect(await loader.listPrompts()).toEqual([]);
	});
});
