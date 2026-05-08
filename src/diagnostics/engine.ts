import { extname } from "node:path";
import { ALL_CHECKERS } from "./checkers.js";
import type { Diagnostic, LanguageChecker } from "./types.js";

export interface DiagnosticsEngineOptions {
	cwd: string;
	checkers?: readonly LanguageChecker[];
}

/**
 * Runs language checkers against files the agent just touched and returns
 * the diagnostics to inject. Detection is cached per project so we don't
 * re-stat go.mod / tsconfig.json on every call.
 */
export class DiagnosticsEngine {
	private readonly cwd: string;
	private readonly checkers: readonly LanguageChecker[];
	private readonly detectCache = new Map<string, Promise<boolean>>();

	constructor(options: DiagnosticsEngineOptions) {
		this.cwd = options.cwd;
		this.checkers = options.checkers ?? ALL_CHECKERS;
	}

	/** Run every applicable checker for the supplied files, in parallel. */
	async forFiles(files: string[], signal?: AbortSignal): Promise<Diagnostic[]> {
		if (files.length === 0) return [];
		const byChecker: Map<LanguageChecker, string[]> = new Map();

		for (const file of files) {
			const ext = extname(file).toLowerCase();
			for (const checker of this.checkers) {
				if (!checker.extensions.includes(ext)) continue;
				if (!(await this.detect(checker))) continue;
				const list = byChecker.get(checker) ?? [];
				list.push(file);
				byChecker.set(checker, list);
			}
		}

		const runs = Array.from(byChecker.entries()).map(([checker, list]) =>
			checker.run(this.cwd, list, signal).catch(() => [] as Diagnostic[]),
		);
		const results = await Promise.all(runs);
		return results.flat();
	}

	private detect(checker: LanguageChecker): Promise<boolean> {
		const cached = this.detectCache.get(checker.name);
		if (cached) return cached;
		const promise = checker.detect(this.cwd);
		this.detectCache.set(checker.name, promise);
		return promise;
	}
}

/**
 * Format a diagnostic batch as a steering message body — grouped by file,
 * one line per finding. Intended to be appended verbatim to a "post-edit"
 * system reminder so the model sees them on its next turn.
 */
export function formatDiagnostics(diags: Diagnostic[]): string {
	if (diags.length === 0) return "";
	const byFile: Map<string, Diagnostic[]> = new Map();
	for (const d of diags) {
		const list = byFile.get(d.file) ?? [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const lines: string[] = [`${diags.length} diagnostic${diags.length === 1 ? "" : "s"} after the last edit:`, ""];
	for (const [file, fileDiags] of byFile) {
		lines.push(file === "" ? "(unknown file):" : `${file}:`);
		for (const d of fileDiags) {
			const loc = d.column ? `${d.line}:${d.column}` : `${d.line}`;
			lines.push(`  Line ${loc} [${d.severity}] (${d.source}): ${d.message}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
