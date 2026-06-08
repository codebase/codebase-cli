import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SshHost } from "./config.js";

/**
 * Read/write the user-wide SSH host list (~/.codebase/ssh.json). The
 * `codebase ssh add / rm` CLI commands go through here. Project-level
 * config is read-only from a CLI standpoint — users hand-edit
 * `<cwd>/.codebase/ssh.json` if they want a project-scoped entry.
 *
 * Persistence is paranoid: write to a temp file then rename, so a power
 * cut mid-save can't half-write the registry.
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface SshStoreOptions {
	home?: string;
}

export class SshStore {
	private readonly path: string;
	constructor(opts: SshStoreOptions = {}) {
		const home = opts.home ?? homedir();
		this.path = join(home, ".codebase", "ssh.json");
	}

	get filePath(): string {
		return this.path;
	}

	list(): SshHost[] {
		if (!existsSync(this.path)) return [];
		try {
			const body = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(body) as { hosts?: SshHost[] };
			return Array.isArray(parsed.hosts) ? parsed.hosts : [];
		} catch {
			return [];
		}
	}

	add(host: SshHost): void {
		if (!NAME_PATTERN.test(host.name)) {
			throw new Error(`host name "${host.name}" must match ${NAME_PATTERN.source}`);
		}
		const hosts = this.list().filter((h) => h.name !== host.name);
		hosts.push(host);
		this.write(hosts);
	}

	remove(name: string): boolean {
		const hosts = this.list();
		const next = hosts.filter((h) => h.name !== name);
		if (next.length === hosts.length) return false;
		this.write(next);
		return true;
	}

	private write(hosts: SshHost[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp.${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
		// Rename is atomic on POSIX; on Windows it's near-atomic and good
		// enough for a config file.
		renameSync(tmp, this.path);
	}
}
