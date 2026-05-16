import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_VERSION = 1;

export type CredentialSource = "codebase" | "manual" | "byok";

export interface Credentials {
	version: number;
	accessToken: string;
	refreshToken?: string;
	/** Unix epoch milliseconds. Undefined for credentials that don't expire. */
	expiresAt?: number;
	scopes: string[];
	userId?: string;
	email?: string;
	/**
	 * How the credential was obtained.
	 *  - `codebase`: OAuth flow against codebase.design — proxy mode
	 *  - `manual`:   `codebase auth <cbk_xxx>` paste — proxy mode
	 *  - `byok`:     "bring your own key" — provider's own API, no proxy
	 *                requires the `provider` field below.
	 */
	source: CredentialSource;
	/**
	 * Set only when `source === "byok"`. Names the pi-ai provider (e.g.
	 * `anthropic`, `openai`) that owns the key. Determines which baseUrl
	 * + model registry the agent uses.
	 */
	provider?: string;
}

export interface CredentialsStoreOptions {
	dataRoot?: string;
}

/**
 * Stores OAuth/API credentials at `~/.codebase/credentials.json`. File
 * mode is enforced to 0600 on every write — readable only by the user.
 *
 * load() returns null when the file is missing, malformed, an
 * unrecognized version, or fails the basic shape check. Clearing
 * malformed files prevents the agent from getting stuck on a corrupt
 * artifact between releases.
 */
export class CredentialsStore {
	private readonly path: string;

	constructor(options: CredentialsStoreOptions = {}) {
		const dataRoot = options.dataRoot ?? join(homedir(), ".codebase");
		this.path = join(dataRoot, "credentials.json");
	}

	get filePath(): string {
		return this.path;
	}

	/**
	 * True iff a credentials file exists on disk, regardless of whether
	 * it parses or whether the token is still valid. Used to detect
	 * "user has gone through the first-run wizard at least once" so we
	 * don't silently skip the OAuth offer for a brand-new install just
	 * because some stray API key happens to be in the shell env.
	 */
	exists(): boolean {
		return existsSync(this.path);
	}

	load(): Credentials | null {
		if (!existsSync(this.path)) return null;
		// Mode invariant: tokens live behind 0600. We enforce on save, but a
		// user could chmod the file or have a permissive umask after the
		// fact — in that case quietly heal by re-chmod'ing AND emit a
		// stderr warning so they know. Anything stricter (e.g. refusing to
		// load) would lock people out of their own session over a chmod
		// they didn't realise mattered. Warn-and-heal is the friendly path.
		try {
			const currentMode = statSync(this.path).mode & 0o777;
			if (currentMode !== 0o600) {
				process.stderr.write(
					`[auth] credentials file mode is 0${currentMode.toString(8)} — should be 0600. Fixing.\n`,
				);
				try {
					chmodSync(this.path, 0o600);
				} catch {
					// non-fatal — Windows/ACL systems don't support chmod
				}
			}
		} catch {
			// stat failed — file race during read; let the readFileSync below surface it
		}
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (err) {
			// Read failed (permission denied, EIO, etc.) — surface the
			// actual reason so the user can fix it. Returning null silently
			// here used to make a broken FS look like "not signed in," which
			// just hid the real problem.
			process.stderr.write(
				`[auth] could not read ${this.path}: ${(err as Error).message}\n` +
					"        run `codebase auth status` for details or `codebase auth logout` to reset.\n",
			);
			return null;
		}
		let parsed: Credentials;
		try {
			parsed = JSON.parse(raw) as Credentials;
		} catch (err) {
			// Don't auto-clear — that silently destroys recoverable state if
			// the user can hand-fix the file (partial write after a crash,
			// merge conflict markers, etc.). Tell them what's wrong and how
			// to recover. They can wipe with `codebase auth logout` if they
			// don't want to repair by hand.
			process.stderr.write(
				`[auth] credentials file ${this.path} is not valid JSON: ${(err as Error).message}\n` +
					"        run `codebase auth logout` to reset and start over with `codebase auth login`.\n",
			);
			return null;
		}
		if (parsed.version !== CREDENTIALS_VERSION) {
			process.stderr.write(
				`[auth] credentials file is version ${parsed.version ?? "?"} but this CLI expects ${CREDENTIALS_VERSION} — ignoring. ` +
					"Run `codebase auth login` to re-authenticate.\n",
			);
			return null;
		}
		if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return null;
		if (!Array.isArray(parsed.scopes)) return null;
		if (parsed.source !== "codebase" && parsed.source !== "manual" && parsed.source !== "byok") {
			return null;
		}
		if (parsed.source === "byok" && (typeof parsed.provider !== "string" || !parsed.provider)) {
			return null;
		}
		return parsed;
	}

	save(credentials: Omit<Credentials, "version">): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const payload: Credentials = { version: CREDENTIALS_VERSION, ...credentials };
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
		// Re-assert mode after rename — some platforms preserve the tmp's
		// mode but it's cheap insurance.
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// non-fatal on systems that don't support chmod (Windows w/ ACLs)
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

	/** True when credentials exist and the access token has expired (with 60s skew). */
	isExpired(credentials?: Credentials | null): boolean {
		const creds = credentials ?? this.load();
		if (!creds) return false;
		if (!creds.expiresAt) return false;
		return creds.expiresAt - 60_000 <= Date.now();
	}

	/** Inspect file mode — used by tests and `codebase auth status` to verify the 0600 invariant. */
	mode(): number | null {
		if (!existsSync(this.path)) return null;
		return statSync(this.path).mode & 0o777;
	}
}
