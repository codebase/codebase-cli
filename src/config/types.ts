/**
 * Schema for codebase-cli's layered config files. Forward-compatible:
 * unknown keys are preserved on read but ignored by typed consumers.
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

	/**
	 * Persisted model preference. When set, used as the model override on
	 * proxy/OAuth sessions instead of "Codebase Auto". Written by /model
	 * (without --session) and read by resolveConfig at agent start.
	 *
	 * `provider` is optional — when omitted, the modelId is sent through
	 * the proxy verbatim and the backend's registry routes it.
	 */
	model?: {
		provider?: string;
		modelId: string;
	};

	/**
	 * Active output style id (filename without `.md`). When set and the
	 * style exists, its body is appended to the system prompt to reshape
	 * response formatting. Written by /output-style; read at agent start.
	 */
	outputStyle?: string;

	/** Forward-compatibility: unknown keys are preserved on load. */
	[key: string]: unknown;
}

export const EMPTY_CONFIG: Config = Object.freeze({}) as Config;
