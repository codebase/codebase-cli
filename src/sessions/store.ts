import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const SESSION_MAX_AGE_DAYS = 7;
export const SESSION_FORMAT_VERSION = 1;

export interface SessionData {
	formatVersion: number;
	workDir: string;
	modelId: string;
	title: string | null;
	messages: AgentMessage[];
	usage: Usage;
	updatedAt: number;
}

export interface SessionStoreOptions {
	cwd: string;
	dataRoot?: string;
	maxAgeDays?: number;
}

/**
 * Per-cwd session snapshot. Filename is keyed off sha256(cwd)[:8] so we
 * can find prior sessions for the same directory across cli launches.
 *
 * load() returns null when no session exists, when the saved session
 * predates `maxAgeDays`, or when the saved model id doesn't match the
 * currently-resolved model — switching models invalidates compaction
 * summaries and tool histories so a fresh start is the safer default.
 */
export class SessionStore {
	private readonly cwd: string;
	private readonly path: string;
	private readonly maxAgeMs: number;

	constructor(options: SessionStoreOptions) {
		this.cwd = options.cwd;
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		const hash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 8);
		this.path = join(dataRoot, "sessions", `${hash}.json`);
		this.maxAgeMs = (options.maxAgeDays ?? SESSION_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
	}

	get filePath(): string {
		return this.path;
	}

	load(modelId: string): SessionData | null {
		if (!existsSync(this.path)) return null;

		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return null;
		}

		let parsed: SessionData;
		try {
			parsed = JSON.parse(raw) as SessionData;
		} catch {
			// Malformed: drop the file so we don't trip over it forever.
			this.clear();
			return null;
		}

		if (parsed.formatVersion !== SESSION_FORMAT_VERSION) return null;
		if (parsed.workDir !== this.cwd) return null;
		if (parsed.modelId !== modelId) return null;
		if (Date.now() - parsed.updatedAt > this.maxAgeMs) {
			this.clear();
			return null;
		}
		if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
		return parsed;
	}

	save(data: Omit<SessionData, "formatVersion" | "workDir" | "updatedAt">): void {
		const dir = join(this.path, "..");
		mkdirSync(dir, { recursive: true });
		const payload: SessionData = {
			formatVersion: SESSION_FORMAT_VERSION,
			workDir: this.cwd,
			updatedAt: Date.now(),
			...data,
		};
		const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
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

	clear(): boolean {
		if (!existsSync(this.path)) return false;
		try {
			unlinkSync(this.path);
			return true;
		} catch {
			return false;
		}
	}

	/** Modification time of the persisted session, or null if absent. */
	mtime(): number | null {
		if (!existsSync(this.path)) return null;
		return statSync(this.path).mtimeMs;
	}
}
