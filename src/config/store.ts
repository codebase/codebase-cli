import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, EMPTY_CONFIG } from "./types.js";

export interface ConfigStoreOptions {
	/** Override homedir lookup for tests. */
	home?: string;
	/** Override cwd lookup for tests. */
	cwd?: string;
}

/**
 * Layered config loader. Reads three files in priority order (later
 * overrides earlier) and returns one merged Config:
 *
 *   1. ~/.codebase/config.json          — user defaults
 *   2. <cwd>/.codebase/config.json      — project (committed)
 *   3. ~/.codebase/config.local.json    — local overrides (gitignored)
 *
 * Merge semantics: object keys deep-merge. Arrays inside known
 * additive keys (currently `permissions.allow` and `permissions.deny`)
 * are concatenated and de-duplicated; arrays elsewhere are replaced.
 *
 * Missing files are silently empty. Malformed JSON throws ConfigError
 * with the offending path so the user can fix it (we don't want to
 * silently ignore typos in their settings).
 */
export class ConfigStore {
	private readonly userPath: string;
	private readonly projectPath: string;
	private readonly localPath: string;
	private cached: Config | null = null;

	constructor(options: ConfigStoreOptions = {}) {
		const home = options.home ?? homedir();
		const cwd = options.cwd ?? process.cwd();
		this.userPath = join(home, ".codebase", "config.json");
		this.projectPath = join(cwd, ".codebase", "config.json");
		this.localPath = join(home, ".codebase", "config.local.json");
	}

	/** Resolved layered paths, in merge order (low → high priority). */
	get sources(): readonly string[] {
		return [this.userPath, this.projectPath, this.localPath];
	}

	/** Force re-read on next load(). */
	invalidate(): void {
		this.cached = null;
	}

	load(): Config {
		if (this.cached) return this.cached;
		let merged: Config = { ...EMPTY_CONFIG };
		for (const path of this.sources) {
			const layer = readLayer(path);
			if (layer) merged = mergeConfig(merged, layer);
		}
		this.cached = merged;
		return merged;
	}

	/** Convenience: get the resolved permission allow patterns. */
	allowPatterns(): readonly string[] {
		return this.load().permissions?.allow ?? [];
	}

	/** Convenience: get the resolved permission deny patterns. */
	denyPatterns(): readonly string[] {
		return this.load().permissions?.deny ?? [];
	}

	/** Convenience: get the persisted model preference, if any. */
	preferredModel(): Config["model"] {
		return this.load().model;
	}

	/** The active output-style id, if one is selected. */
	outputStyle(): string | undefined {
		const v = this.load().outputStyle;
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	}

	/** Persist the active output-style id at the user layer. Pass null to clear. */
	setOutputStyle(id: string | null): void {
		const existing = readLayer(this.userPath) ?? { ...EMPTY_CONFIG };
		const next: Config = { ...existing };
		if (id === null) {
			delete next.outputStyle;
		} else {
			next.outputStyle = id;
		}
		mkdirSync(dirname(this.userPath), { recursive: true });
		writeFileSync(this.userPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
		this.invalidate();
	}

	/**
	 * Persist a model preference at the *user* layer (`~/.codebase/config.json`).
	 * Pass `null` to clear. Reads-then-writes the user file so unrelated
	 * fields are preserved. Cache is invalidated; next load() picks up the
	 * change.
	 */
	setPreferredModel(model: Config["model"] | null): void {
		const existing = readLayer(this.userPath) ?? { ...EMPTY_CONFIG };
		const next: Config = { ...existing };
		if (model === null) {
			delete next.model;
		} else {
			next.model = model;
		}
		mkdirSync(dirname(this.userPath), { recursive: true });
		writeFileSync(this.userPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
		this.invalidate();
	}
}

export class ConfigError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "ConfigError";
	}
}

function readLayer(path: string): Config | null {
	if (!existsSync(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ConfigError(
			`could not parse ${path} as JSON: ${err instanceof Error ? err.message : String(err)}`,
			path,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`${path} must contain a JSON object at the top level`, path);
	}
	return parsed as Config;
}

/**
 * Deep-merge two Configs. The right operand wins for scalars and
 * non-array fields. For the additive arrays under `permissions`,
 * concatenate + de-duplicate so users can layer rules without losing
 * earlier-layer entries.
 */
export function mergeConfig(base: Config, overlay: Config): Config {
	const out: Config = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (key === "permissions" && isObject(value) && isObject(out.permissions)) {
			out.permissions = mergePermissions(out.permissions, value);
			continue;
		}
		(out as Record<string, unknown>)[key] = value;
	}
	return out;
}

function mergePermissions(
	base: NonNullable<Config["permissions"]>,
	overlay: NonNullable<Config["permissions"]>,
): NonNullable<Config["permissions"]> {
	const merged = { ...base, ...overlay };
	if (overlay.allow && base.allow) {
		merged.allow = dedupe([...base.allow, ...overlay.allow]);
	}
	if (overlay.deny && base.deny) {
		merged.deny = dedupe([...base.deny, ...overlay.deny]);
	}
	return merged;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function dedupe<T>(arr: T[]): T[] {
	return Array.from(new Set(arr));
}
