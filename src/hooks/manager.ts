import { readFileSync } from "node:fs";
import { runHook } from "./runner.js";
import type { HookConfig, HookEvent, HookEventContext, HookOutcome, HooksFile } from "./types.js";

/**
 * User-defined hook engine. Loads hook config from one or more JSON
 * files (typically `~/.codebase/hooks.json` and `.codebase/hooks.json`)
 * and dispatches matching hooks for each agent event.
 *
 * Exit code 2 from a synchronous hook blocks the in-flight tool call —
 * pi-agent-core converts that block into an error tool-result so the
 * model gets the hook's stderr as feedback.
 */
export class HookManager {
	private readonly configs: HookConfig[] = [];

	/**
	 * Load and append hook configs from the given file paths in order.
	 * Missing files are silently skipped; malformed JSON is logged but
	 * non-fatal so a typo in one project's hooks.json doesn't break the
	 * agent.
	 */
	loadFrom(...paths: (string | undefined)[]): void {
		for (const path of paths) {
			if (!path) continue;
			let body: string;
			try {
				body = readFileSync(path, "utf8");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					console.warn(`hooks: could not read ${path}: ${(err as Error).message}`);
				}
				continue;
			}
			let parsed: HooksFile;
			try {
				parsed = JSON.parse(body) as HooksFile;
			} catch (err) {
				console.warn(`hooks: ${path} is not valid JSON: ${(err as Error).message}`);
				continue;
			}
			if (!Array.isArray(parsed.hooks)) {
				console.warn(`hooks: ${path} missing top-level "hooks" array`);
				continue;
			}
			for (const config of parsed.hooks) {
				if (validateHook(config, path)) this.configs.push(config);
			}
		}
	}

	/** Hooks visible to the manager. Mainly for tests. */
	all(): readonly HookConfig[] {
		return this.configs;
	}

	matching(event: HookEvent, context: HookEventContext): HookConfig[] {
		return this.configs.filter((h) => h.event === event && hookMatches(h.matcher, context));
	}

	async dispatch(event: HookEvent, context: HookEventContext, signal?: AbortSignal): Promise<HookOutcome> {
		const matching = this.matching(event, context);
		let ranCount = 0;

		for (const config of matching) {
			if (config.async) {
				runHook(config, context, signal).catch(() => {
					// fire-and-forget; nothing to do on failure
				});
				ranCount++;
				continue;
			}
			const result = await runHook(config, context, signal);
			ranCount++;
			if (result.exitCode === 2) {
				return {
					blocked: true,
					reason: result.stderr.trim() || `blocked by hook (event=${event})`,
					ranCount,
				};
			}
		}
		return { blocked: false, ranCount };
	}
}

function validateHook(config: unknown, source: string): config is HookConfig {
	if (!config || typeof config !== "object") {
		console.warn(`hooks: ${source} contains a non-object hook entry, skipping`);
		return false;
	}
	const c = config as Partial<HookConfig>;
	if (!c.event) {
		console.warn(`hooks: ${source} hook missing "event", skipping`);
		return false;
	}
	if (!c.command || typeof c.command !== "string") {
		console.warn(`hooks: ${source} hook ${c.event} missing "command", skipping`);
		return false;
	}
	return true;
}

/**
 * Matcher syntax:
 *   undefined or ""    → match anything
 *   "tool"             → exact tool name
 *   "toolA|toolB"      → either
 *   "tool:pathPattern" → tool name AND filePath matches pathPattern
 *   "*:pathPattern"    → any tool whose filePath matches pathPattern
 *
 * Pattern segments support `*` (any chars, no separator) and `**` (any
 * chars including separators) — same as gitignore-style globs but
 * minimal.
 */
export function hookMatches(matcher: string | undefined, context: HookEventContext): boolean {
	if (!matcher) return true;
	const [toolPart, pathPart] = matcher.split(":", 2);

	if (toolPart && toolPart !== "*") {
		const alternatives = toolPart.split("|").map((s) => s.trim());
		if (!alternatives.includes(context.toolName ?? "")) return false;
	}

	if (pathPart) {
		if (!context.filePath) return false;
		if (!globMatches(pathPart, context.filePath)) return false;
	}

	return true;
}

function globMatches(pattern: string, value: string): boolean {
	const re = new RegExp(`^${globToRegex(pattern)}$`);
	return re.test(value);
}

function globToRegex(pattern: string): string {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (/[\\^$+.()|{}[\]]/.test(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return out;
}
