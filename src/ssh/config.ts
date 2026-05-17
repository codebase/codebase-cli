import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * SSH host registry. Each entry is a named target the agent's
 * ssh_exec / ssh_copy tools can reach. The KEY SECURITY PROPERTY:
 *
 *   Hosts are addressed by NAME, never by `user@hostname` string.
 *
 * The model can't decide where to SSH — it can only name a host the
 * user has explicitly enrolled. This bounds the blast radius of any
 * prompt injection / model hallucination. Even if a malicious payload
 * tells the model "ssh into root@target.gov and run rm -rf /", the
 * model can only choose from the enrolled allowlist; "target.gov" is
 * not there, the call fails before reaching ssh.
 *
 * Config locations (merged, project wins on name conflict):
 *   ~/.codebase/ssh.json        — user-wide hosts
 *   <cwd>/.codebase/ssh.json    — project-specific hosts
 *
 * Schema:
 *   { hosts: [{ name, host, user?, port?, identityFile?, description? }] }
 */

export interface SshHost {
	/** Short name the agent / user refers to (e.g. "staging"). [a-z0-9_-]+ */
	name: string;
	/** Hostname or IP. */
	host: string;
	/** Optional remote user. Defaults to current local user if omitted. */
	user?: string;
	/** Optional non-default port. */
	port?: number;
	/** Optional explicit identity file path (tilde-expanded). Defaults to ssh's normal key search. */
	identityFile?: string;
	/** Free-form note shown in `codebase ssh list`. */
	description?: string;
}

interface SshConfigFile {
	hosts?: unknown;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class SshConfig {
	readonly hosts: readonly SshHost[];

	constructor(hosts: readonly SshHost[]) {
		this.hosts = hosts;
	}

	get(name: string): SshHost | undefined {
		return this.hosts.find((h) => h.name === name);
	}

	listNames(): readonly string[] {
		return this.hosts.map((h) => h.name);
	}
}

export interface LoadSshConfigOptions {
	cwd?: string;
	home?: string;
}

/**
 * Read the merged SSH config. Project-level hosts override user-level
 * hosts with the same name. Missing files yield empty configs; malformed
 * files emit a stderr warning and skip — a single typo in one project
 * doesn't break the agent everywhere.
 */
export function loadSshConfig(opts: LoadSshConfigOptions = {}): SshConfig {
	const home = opts.home ?? homedir();
	const cwd = opts.cwd ?? process.cwd();
	const userPath = join(home, ".codebase", "ssh.json");
	const projectPath = join(cwd, ".codebase", "ssh.json");

	const merged = new Map<string, SshHost>();
	for (const path of [userPath, projectPath]) {
		for (const host of readHosts(path)) {
			merged.set(host.name, host);
		}
	}
	return new SshConfig(Array.from(merged.values()));
}

function readHosts(path: string): readonly SshHost[] {
	if (!existsSync(path)) return [];
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch (err) {
		process.stderr.write(`[ssh] could not read ${path}: ${(err as Error).message}\n`);
		return [];
	}
	let parsed: SshConfigFile;
	try {
		parsed = JSON.parse(body) as SshConfigFile;
	} catch (err) {
		process.stderr.write(`[ssh] ${path} is not valid JSON: ${(err as Error).message}\n`);
		return [];
	}
	if (!Array.isArray(parsed.hosts)) {
		process.stderr.write(`[ssh] ${path} missing top-level "hosts" array — skipping\n`);
		return [];
	}
	const out: SshHost[] = [];
	for (const entry of parsed.hosts) {
		const host = validateHost(entry, path);
		if (host) out.push(host);
	}
	return out;
}

function validateHost(entry: unknown, source: string): SshHost | undefined {
	if (!entry || typeof entry !== "object") {
		process.stderr.write(`[ssh] ${source}: non-object host entry, skipping\n`);
		return undefined;
	}
	const e = entry as Record<string, unknown>;
	if (typeof e.name !== "string" || !NAME_PATTERN.test(e.name)) {
		process.stderr.write(
			`[ssh] ${source}: host name "${String(e.name)}" missing or invalid (must match ${NAME_PATTERN.source}); skipping\n`,
		);
		return undefined;
	}
	if (typeof e.host !== "string" || e.host.length === 0) {
		process.stderr.write(`[ssh] ${source}: host "${e.name}" missing "host" field; skipping\n`);
		return undefined;
	}
	// Reject anything that smells like the user is trying to encode
	// "user@host" or "host:port" in the host field. We want explicit fields.
	if (e.host.includes("@") || e.host.includes(":") || /\s/.test(e.host)) {
		process.stderr.write(
			`[ssh] ${source}: host "${e.name}" hostname "${e.host}" looks like user@host:port syntax — use separate user/port fields; skipping\n`,
		);
		return undefined;
	}
	const host: SshHost = { name: e.name, host: e.host };
	if (e.user !== undefined) {
		if (typeof e.user !== "string" || !/^[a-zA-Z0-9._-]+$/.test(e.user)) {
			process.stderr.write(`[ssh] ${source}: host "${e.name}" user "${String(e.user)}" invalid; skipping\n`);
			return undefined;
		}
		host.user = e.user;
	}
	if (e.port !== undefined) {
		const port = Number(e.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			process.stderr.write(`[ssh] ${source}: host "${e.name}" port "${String(e.port)}" invalid; skipping\n`);
			return undefined;
		}
		host.port = port;
	}
	if (e.identityFile !== undefined) {
		if (typeof e.identityFile !== "string" || e.identityFile.length === 0) {
			process.stderr.write(`[ssh] ${source}: host "${e.name}" identityFile invalid; skipping\n`);
			return undefined;
		}
		host.identityFile = e.identityFile;
	}
	if (e.description !== undefined) {
		host.description = typeof e.description === "string" ? e.description : String(e.description);
	}
	return host;
}
