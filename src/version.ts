import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the running CLI's version at runtime by reading the bundled
 * package.json. This is the single source of truth for "what am I
 * running" — surfaced in the welcome banner, the status bar, and the
 * `--version` flag so the user can never wonder again whether their
 * shell is launching the build they just compiled.
 *
 * Fallback to "?.?.?" if the lookup fails for any reason; a missing
 * version string shouldn't crash the agent.
 */
export const VERSION: string = (() => {
	try {
		// dist/version.js → dist/ → package.json
		// src/version.ts (via tsx) → src/  → package.json
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
		return pkg.version ?? "?.?.?";
	} catch {
		return "?.?.?";
	}
})();
