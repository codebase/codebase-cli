import { randomBytes } from "node:crypto";
import {
	chmodSync,
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
import type { Usage } from "@earendil-works/pi-ai";
import { redactSecrets } from "../memory/secrets.js";
import type { ReliabilityReceipt } from "./reliable.js";

export const RECEIPT_SCHEMA_VERSION = 1;

export interface ReceiptRecord {
	schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
	id: string;
	createdAt: string;
	cwd: string;
	prompt: string;
	ok: boolean;
	exitCode: number;
	error?: string;
	code?: string;
	durationMs: number;
	model: { provider: string; id: string; name: string };
	source: string;
	usage: Usage;
	finalText: string;
	receipt: ReliabilityReceipt;
}

export interface SaveReceiptInput {
	cwd: string;
	prompt: string;
	ok: boolean;
	exitCode: number;
	error?: string;
	code?: string;
	durationMs: number;
	model: ReceiptRecord["model"];
	source: string;
	usage: Usage;
	finalText: string;
	receipt: ReliabilityReceipt;
}

export interface ReceiptStoreOptions {
	dataRoot?: string;
}

export class ReceiptStore {
	private readonly dir: string;
	private lastCreatedAtMs = 0;

	constructor(options: ReceiptStoreOptions = {}) {
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		this.dir = join(dataRoot, "receipts");
	}

	get directory(): string {
		return this.dir;
	}

	pathFor(id: string): string {
		return join(this.dir, `${safeId(id)}.json`);
	}

	save(input: SaveReceiptInput): ReceiptRecord {
		mkdirSync(this.dir, { recursive: true });
		const createdAtMs = Math.max(Date.now(), this.lastCreatedAtMs + 1);
		this.lastCreatedAtMs = createdAtMs;
		const record: ReceiptRecord = {
			schemaVersion: RECEIPT_SCHEMA_VERSION,
			id: newReceiptId(createdAtMs),
			createdAt: new Date(createdAtMs).toISOString(),
			...redactReceiptInput(input),
		};
		const path = this.pathFor(record.id);
		const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, path);
			try {
				chmodSync(path, 0o600);
			} catch {
				// non-fatal on platforms that do not support chmod
			}
			return record;
		} catch (err) {
			tryUnlink(tmp);
			throw err;
		}
	}

	list(): ReceiptRecord[] {
		let files: string[];
		try {
			files = readdirSync(this.dir).filter((file) => file.endsWith(".json"));
		} catch {
			return [];
		}
		const records: ReceiptRecord[] = [];
		for (const file of files) {
			const record = this.readPath(join(this.dir, file));
			if (record) records.push(record);
		}
		return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	}

	load(id = "latest"): ReceiptRecord | null {
		if (id === "latest") return this.list()[0] ?? null;
		return this.readPath(this.pathFor(id));
	}

	mode(id: string): number | null {
		const path = this.pathFor(id);
		if (!existsSync(path)) return null;
		return statSync(path).mode & 0o777;
	}

	private readPath(path: string): ReceiptRecord | null {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as ReceiptRecord;
			return isReceiptRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
}

function redactReceiptInput(input: SaveReceiptInput): SaveReceiptInput {
	return redactReceiptValue(input) as SaveReceiptInput;
}

function redactReceiptValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map((item) => redactReceiptValue(item));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactReceiptValue(item)]),
	);
}

function isReceiptRecord(value: unknown): value is ReceiptRecord {
	if (!value || typeof value !== "object") return false;
	const input = value as Partial<ReceiptRecord>;
	return (
		input.schemaVersion === RECEIPT_SCHEMA_VERSION &&
		typeof input.id === "string" &&
		typeof input.createdAt === "string" &&
		typeof input.cwd === "string" &&
		typeof input.prompt === "string" &&
		typeof input.ok === "boolean" &&
		typeof input.exitCode === "number" &&
		typeof input.durationMs === "number" &&
		!!input.model &&
		typeof input.source === "string" &&
		!!input.receipt
	);
}

function newReceiptId(createdAtMs: number): string {
	const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, "-");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// best effort cleanup
	}
}
