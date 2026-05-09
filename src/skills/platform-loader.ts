import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CredentialsStore } from "../auth/credentials.js";
import type { AssetLoader } from "./loader.js";
import type { PromptAsset, SkillAsset, TemplateAsset } from "./types.js";

const DEFAULT_BASE_URL = "https://codebase.design/api/cli";
const DEFAULT_CACHE_PATH = join(homedir(), ".codebase", "cache", "platform-assets.json");
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedBundle {
	fetchedAt: number;
	etag?: string;
	body: PlatformBundle;
}

interface PlatformBundle {
	skills?: readonly RawSkill[];
	templates?: readonly RawTemplate[];
	prompts?: readonly RawPrompt[];
}

type RawSkill = Omit<SkillAsset, "kind" | "source">;
type RawTemplate = Omit<TemplateAsset, "kind" | "source">;
type RawPrompt = Omit<PromptAsset, "kind" | "source">;

export interface PlatformLoaderOptions {
	credentials?: CredentialsStore;
	baseUrl?: string;
	cachePath?: string;
	ttlMs?: number;
	fetchFn?: typeof fetch;
	/** Override Date.now() for tests. */
	now?: () => number;
}

/**
 * Fetches the user's curated skills/templates/prompts from
 * codebase.design and merges them into the AssetRegistry. Caches
 * the response under ~/.codebase/cache/platform-assets.json so
 * subsequent CLI launches don't pay the round trip.
 *
 * Wire format (server returns one bundle, the loader fans it out
 * into the three asset kinds):
 *
 *   GET ${baseUrl}/assets
 *   Authorization: Bearer <accessToken>
 *
 *   200 OK
 *   { "skills":    [ { id, name, description, systemPrompt, tags?, preferredModel? }, … ],
 *     "templates": [ { id, name, description, body, files?, tags? }, … ],
 *     "prompts":   [ { id, name, description, body, tags? }, … ] }
 *
 * Behavior matrix:
 *
 *   not signed in         → returns [] without a network call
 *   network error         → returns the last cached body if any,
 *                           else [] (silent — never crashes a session)
 *   404 (endpoint TBD)    → caches an empty bundle, returns []
 *                           (no warning — the backend half is
 *                           expected to land later, see
 *                           docs/plans/2026-05-09-codebase-cli-
 *                           oauth-server-side.md §3-4)
 *   200                   → caches body + ETag, returns shaped list
 *   304 (ETag match)      → bumps the cache timestamp, returns cached
 */
export class PlatformLoader implements AssetLoader {
	readonly source = "platform" as const;

	private readonly credentials: CredentialsStore;
	private readonly baseUrl: string;
	private readonly cachePath: string;
	private readonly ttlMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;

	private inFlight: Promise<PlatformBundle> | null = null;

	constructor(options: PlatformLoaderOptions = {}) {
		this.credentials = options.credentials ?? new CredentialsStore();
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
		this.now = options.now ?? Date.now;
	}

	async listSkills(): Promise<readonly SkillAsset[]> {
		const bundle = await this.bundle();
		return (bundle.skills ?? []).map((s) => ({ ...s, kind: "skill" as const, source: this.source }));
	}

	async listTemplates(): Promise<readonly TemplateAsset[]> {
		const bundle = await this.bundle();
		return (bundle.templates ?? []).map((t) => ({ ...t, kind: "template" as const, source: this.source }));
	}

	async listPrompts(): Promise<readonly PromptAsset[]> {
		const bundle = await this.bundle();
		return (bundle.prompts ?? []).map((p) => ({ ...p, kind: "prompt" as const, source: this.source }));
	}

	/** Force the next list call to re-fetch instead of using the cache. */
	invalidate(): void {
		try {
			if (existsSync(this.cachePath)) {
				writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: 0, body: {} }));
			}
		} catch {
			// non-fatal
		}
	}

	private async bundle(): Promise<PlatformBundle> {
		// Coalesce concurrent calls — listSkills + listTemplates + listPrompts
		// from a single registry pass should share one fetch.
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.bundleOnce().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async bundleOnce(): Promise<PlatformBundle> {
		// Not signed in → never fetch, never cache, never warn.
		const creds = this.credentials.load();
		if (!creds || this.credentials.isExpired(creds)) return {};

		const cached = readCache(this.cachePath);
		const fresh = cached && this.now() - cached.fetchedAt < this.ttlMs;
		if (fresh) return cached.body;

		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${creds.accessToken}`,
				Accept: "application/json",
			};
			if (cached?.etag) headers["If-None-Match"] = cached.etag;

			const res = await this.fetchFn(`${this.baseUrl}/assets`, { headers });

			if (res.status === 304 && cached) {
				// ETag match — bump the cache timestamp, return cached body.
				writeCache(this.cachePath, { ...cached, fetchedAt: this.now() });
				return cached.body;
			}

			if (res.status === 404) {
				// Endpoint TBD. Cache an empty bundle so we don't hammer the
				// server until the next TTL window.
				const empty: CachedBundle = { fetchedAt: this.now(), body: {} };
				writeCache(this.cachePath, empty);
				return empty.body;
			}

			if (res.status === 401 || !res.ok) {
				// Auth blip or transient 5xx — fall back to whatever's cached.
				return cached?.body ?? {};
			}

			const body = (await res.json()) as PlatformBundle;
			const etag = res.headers.get("ETag") ?? undefined;
			writeCache(this.cachePath, { fetchedAt: this.now(), etag, body });
			return body;
		} catch {
			// Network failures degrade to cached. Never throw — a flaky
			// platform shouldn't take the agent down.
			return cached?.body ?? {};
		}
	}
}

function readCache(path: string): CachedBundle | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as CachedBundle;
		if (typeof parsed.fetchedAt !== "number") return null;
		if (!parsed.body || typeof parsed.body !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeCache(path: string, bundle: CachedBundle): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(bundle));
	} catch {
		// non-fatal — the in-memory result still serves the current process
	}
}
