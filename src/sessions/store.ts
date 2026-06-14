import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const SESSION_MAX_AGE_DAYS = 30;
export const SESSION_FORMAT_VERSION = 1;

export interface SessionData {
	formatVersion: number;
	workDir: string;
	modelId: string;
	title: string | null;
	tags?: string[];
	messages: AgentMessage[];
	usage: Usage;
	updatedAt: number;
}

export interface SessionSummary {
	id: string;
	title: string | null;
	tags: string[];
	modelId: string;
	messageCount: number;
	updatedAt: number;
}

export interface SessionStoreOptions {
	cwd: string;
	dataRoot?: string;
	maxAgeDays?: number;
	/** Bind to an existing session id instead of minting a fresh one. */
	sessionId?: string;
}

/**
 * Per-project session storage: `~/.codebase/sessions/<cwd-hash>/<id>.json`,
 * one file per session, so starting a new conversation never destroys a
 * prior one. The store is bound to one session id — a fresh id by
 * default; load()/loadById() adopt the resumed session's id so subsequent
 * saves continue that session rather than forking it.
 *
 * The pre-multi-session layout was a single `<cwd-hash>.json`; it's
 * migrated into the directory on first construction.
 *
 * load() (auto-resume) returns the newest valid session, requiring a
 * model-id match — switching models invalidates compaction summaries so
 * a fresh start is the safer default. loadById() is the explicit-pick
 * path and skips the model check: the user chose it on purpose.
 */
export class SessionStore {
	private readonly cwd: string;
	private readonly dir: string;
	private readonly maxAgeMs: number;
	private sessionId: string;
	/**
	 * User-set title/tags (via /rename, /tag) that must survive the agent's
	 * periodic save — which passes only the resumed title and never tags.
	 * Seeded from the adopted session on resume; applied in save().
	 */
	private readonly overrides: { title?: string | null; tags?: string[] } = {};

	constructor(options: SessionStoreOptions) {
		this.cwd = options.cwd;
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		const hash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 8);
		this.dir = join(dataRoot, "sessions", hash);
		this.maxAgeMs = (options.maxAgeDays ?? SESSION_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
		migrateLegacyFile(join(dataRoot, "sessions", `${hash}.json`), this.dir);
		this.sessionId = options.sessionId ?? newSessionId();
	}

	/** The session this store reads/writes. Adopted from the resumed session on load. */
	get id(): string {
		return this.sessionId;
	}

	get filePath(): string {
		return join(this.dir, `${this.sessionId}.json`);
	}

	/**
	 * Auto-resume: newest session that matches the model and passes the
	 * validity checks. Adopts that session's id on success.
	 */
	load(modelId: string): SessionData | null {
		for (const summary of this.list()) {
			const data = this.read(summary.id);
			if (!data) continue;
			if (data.modelId !== modelId) continue;
			this.sessionId = summary.id;
			this.seedOverrides(data);
			return data;
		}
		return null;
	}

	/**
	 * Explicit resume of a chosen session. No model check — the user
	 * picked it deliberately. Adopts the id on success.
	 */
	loadById(id: string): SessionData | null {
		if (!SESSION_ID_PATTERN.test(id)) return null;
		const data = this.read(id);
		if (!data) return null;
		this.sessionId = id;
		this.seedOverrides(data);
		return data;
	}

	/**
	 * Every resumable session for this project, newest first. Expired and
	 * malformed files are pruned as a side effect.
	 */
	list(): SessionSummary[] {
		let files: string[];
		try {
			files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		const out: SessionSummary[] = [];
		for (const file of files) {
			const path = join(this.dir, file);
			const id = file.slice(0, -".json".length);
			let parsed: SessionData;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8")) as SessionData;
			} catch {
				tryUnlink(path); // malformed: drop so we don't trip over it forever
				continue;
			}
			if (parsed.formatVersion !== SESSION_FORMAT_VERSION) continue;
			if (parsed.workDir !== this.cwd) continue;
			if (Date.now() - parsed.updatedAt > this.maxAgeMs) {
				tryUnlink(path);
				continue;
			}
			if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) continue;
			out.push({
				id,
				title: parsed.title,
				tags: Array.isArray(parsed.tags) ? parsed.tags : [],
				modelId: parsed.modelId,
				messageCount: parsed.messages.length,
				updatedAt: parsed.updatedAt,
			});
		}
		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	save(data: Omit<SessionData, "formatVersion" | "workDir" | "updatedAt">): void {
		mkdirSync(this.dir, { recursive: true });
		const payload: SessionData = {
			formatVersion: SESSION_FORMAT_VERSION,
			workDir: this.cwd,
			updatedAt: Date.now(),
			...data,
			title: this.overrides.title !== undefined ? this.overrides.title : (data.title ?? deriveTitle(data.messages)),
			tags: this.overrides.tags ?? data.tags ?? [],
		};
		this.writeAtomic(payload);
	}

	/** Set the bound session's display title (via /rename). Persists immediately. */
	rename(title: string): void {
		this.overrides.title = title;
		this.patchFile();
	}

	/** Replace the bound session's tags (via /tag). Persists immediately. */
	setTags(tags: string[]): void {
		this.overrides.tags = tags;
		this.patchFile();
	}

	/** Carry an adopted session's title/tags forward so periodic saves keep them. */
	private seedOverrides(data: SessionData): void {
		this.overrides.title = data.title;
		this.overrides.tags = Array.isArray(data.tags) ? data.tags : [];
	}

	/** Rewrite the already-saved file with current overrides; no-op before the first save. */
	private patchFile(): void {
		if (!existsSync(this.filePath)) return;
		let parsed: SessionData;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SessionData;
		} catch {
			return;
		}
		if (this.overrides.title !== undefined) parsed.title = this.overrides.title;
		if (this.overrides.tags !== undefined) parsed.tags = this.overrides.tags;
		parsed.updatedAt = Date.now();
		this.writeAtomic(parsed);
	}

	private writeAtomic(payload: SessionData): void {
		mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (err) {
			tryUnlink(tmp);
			throw err;
		}
	}

	/** Delete the bound session's file. */
	clear(): boolean {
		if (!existsSync(this.filePath)) return false;
		return tryUnlink(this.filePath);
	}

	/** Modification time of the bound session file, or null if absent. */
	mtime(): number | null {
		if (!existsSync(this.filePath)) return null;
		return statSync(this.filePath).mtimeMs;
	}

	/** Read + validate one session file (everything except the model check). */
	private read(id: string): SessionData | null {
		const path = join(this.dir, `${id}.json`);
		let parsed: SessionData;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as SessionData;
		} catch {
			return null;
		}
		if (parsed.formatVersion !== SESSION_FORMAT_VERSION) return null;
		if (parsed.workDir !== this.cwd) return null;
		// If the project directory the session belongs to has been deleted /
		// renamed since the save, refuse to resume rather than re-anchoring
		// the session to a now-invalid path.
		try {
			if (!statSync(parsed.workDir).isDirectory()) return null;
		} catch {
			return null;
		}
		if (Date.now() - parsed.updatedAt > this.maxAgeMs) {
			tryUnlink(path);
			return null;
		}
		if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
		return parsed;
	}
}

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function newSessionId(): string {
	return `s-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** First user prompt, cleaned and clipped, as the session's display title. */
function deriveTitle(messages: readonly AgentMessage[]): string | null {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const raw =
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content
							.filter(
								(b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
							)
							.map((b) => b.text)
							.join(" ")
					: "";
		const cleaned = raw
			.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!cleaned) continue;
		return cleaned.length > 64 ? `${cleaned.slice(0, 63)}…` : cleaned;
	}
	return null;
}

/** Move the pre-multi-session single file into the per-project directory. */
function migrateLegacyFile(legacyPath: string, dir: string): void {
	try {
		if (!statSync(legacyPath).isFile()) return;
	} catch {
		return;
	}
	try {
		mkdirSync(dir, { recursive: true });
		renameSync(legacyPath, join(dir, `${newSessionId()}.json`));
	} catch {
		// Racing another instance or unwritable dir — leave the legacy file.
	}
}

function tryUnlink(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}
