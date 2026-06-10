import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthTokens, ServerCredentials } from "./types.js";

const STORE_VERSION = 1;

interface StoreFile {
	version: number;
	servers: Record<string, ServerCredentials>;
}

/**
 * Persists per-server MCP OAuth sessions at
 * `~/.codebase/mcp-credentials.json`, keyed by server name. Same 0600 +
 * atomic-rename discipline as the main credentials store — refresh tokens
 * are long-lived and must not leak to other users on the box.
 */
export class McpOAuthStore {
	private readonly path: string;

	constructor(dataRoot: string = join(homedir(), ".codebase")) {
		this.path = join(dataRoot, "mcp-credentials.json");
	}

	get filePath(): string {
		return this.path;
	}

	get(server: string): ServerCredentials | undefined {
		return this.read().servers[server];
	}

	set(server: string, creds: ServerCredentials): void {
		const file = this.read();
		file.servers[server] = creds;
		this.write(file);
	}

	/** Replace just the tokens for a server (after a refresh), keeping client + metadata. */
	updateTokens(server: string, tokens: OAuthTokens): void {
		const existing = this.get(server);
		if (!existing) return;
		this.set(server, { ...existing, tokens });
	}

	delete(server: string): void {
		const file = this.read();
		if (file.servers[server]) {
			delete file.servers[server];
			this.write(file);
		}
	}

	private read(): StoreFile {
		if (!existsSync(this.path)) return { version: STORE_VERSION, servers: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
			if (parsed.version !== STORE_VERSION || !parsed.servers) return { version: STORE_VERSION, servers: {} };
			return parsed;
		} catch {
			// Corrupt file — start clean rather than wedging every connect.
			return { version: STORE_VERSION, servers: {} };
		}
	}

	private write(file: StoreFile): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
			renameSync(tmp, this.path);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				// best effort
			}
			throw err;
		}
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// non-fatal on systems without chmod
		}
	}
}

/**
 * True when the access token is within `skewMs` of expiry (default 60s).
 * Tokens with no `expires_in` are treated as non-expiring.
 */
export function isAccessTokenExpired(tokens: OAuthTokens, skewMs = 60_000): boolean {
	if (!tokens.expires_in) return false;
	const expiresAt = tokens.obtained_at + tokens.expires_in * 1000;
	return expiresAt - skewMs <= Date.now();
}
