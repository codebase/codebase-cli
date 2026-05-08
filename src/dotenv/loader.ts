import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Auto-load `.env` (cwd) then `~/.codebase/.env` into `process.env`.
 *
 * Real env vars always win — a value already present in process.env
 * is never clobbered. This means CI configs (set via the CI's secrets
 * mechanism) override what's in a checked-in .env file, which is the
 * sensible precedence and matches the Go v1 dotenv loader.
 *
 * Returns the list of variables that were actually applied, for
 * telemetry / "auth status"-style reporting.
 */
export function loadDotEnv(cwd: string = process.cwd()): string[] {
	const applied: string[] = [];
	const candidates = [join(cwd, ".env"), join(homedir(), ".codebase", ".env")];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const [key, value] of parseDotEnv(raw)) {
			if (process.env[key] !== undefined) continue;
			process.env[key] = value;
			applied.push(key);
		}
	}

	return applied;
}

/**
 * Parse a .env body into key/value pairs. Supports:
 *   - `KEY=value` and `export KEY=value`
 *   - Single- and double-quoted values (quotes stripped)
 *   - Backslash-escapes inside double-quoted values
 *   - `# comment` lines and trailing comments after unquoted values
 *   - Blank lines
 */
export function parseDotEnv(body: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = body.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const stripped = trimmed.replace(/^export\s+/, "");
		const eq = stripped.indexOf("=");
		if (eq === -1) continue;
		const key = stripped.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		const rest = stripped.slice(eq + 1).trim();
		out.set(key, parseValue(rest));
	}
	return out;
}

function parseValue(raw: string): string {
	if (raw.length === 0) return "";
	const quote = raw[0];
	if (quote === '"' || quote === "'") {
		const end = findClosingQuote(raw, quote);
		if (end === -1) return raw.slice(1);
		const body = raw.slice(1, end);
		return quote === '"' ? unescapeDouble(body) : body;
	}
	// Unquoted: strip trailing comment / inline whitespace
	const hashIdx = raw.indexOf(" #");
	const stop = hashIdx === -1 ? raw.length : hashIdx;
	return raw.slice(0, stop).trim();
}

function findClosingQuote(raw: string, quote: string): number {
	let escaped = false;
	for (let i = 1; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote === '"') {
			escaped = true;
			continue;
		}
		if (ch === quote) return i;
	}
	return -1;
}

function unescapeDouble(body: string): string {
	return body.replace(/\\(.)/g, (_, ch) => {
		switch (ch) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return ch;
		}
	});
}
