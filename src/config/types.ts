/**
 * Schema for codebase-cli's layered config files. Forward-compatible:
 * unknown keys are preserved on read but ignored by typed consumers.
 *
 * The shape mirrors Claude Code's `~/.claude/settings.json` where
 * possible so files port over with minimal edits.
 */
export interface Config {
	/**
	 * Permission rules layered on top of the built-in read-only allowlist
	 * in `src/permissions/store.ts`. Patterns let a user persist trust
	 * decisions across sessions (the in-memory "trust this tool"
	 * response only lasts one session).
	 *
	 * Pattern shape: `tool` to allow every call, or `tool:<arg-glob>` to
	 * allow only when the stringified args match the glob.
	 *   examples:
	 *     "list_files"               → every call
	 *     "shell:git status*"        → only `git status …` shells
	 *     "read_file:src/**"         → reads scoped to src/
	 */
	permissions?: {
		allow?: string[];
		deny?: string[];
	};

	/** Forward-compatibility: unknown keys are preserved on load. */
	[key: string]: unknown;
}

export const EMPTY_CONFIG: Config = Object.freeze({}) as Config;
