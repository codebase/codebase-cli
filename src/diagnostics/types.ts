export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
	/** Path relative to the project cwd. */
	file: string;
	/** 1-based line number. */
	line: number;
	/** 1-based column, if known. */
	column?: number;
	severity: DiagnosticSeverity;
	message: string;
	/** Which checker produced this (e.g. "tsc", "go vet"). */
	source: string;
}

/**
 * A language checker. The engine instantiates one of these per supported
 * language and asks it whether to run for a given project, then runs and
 * parses output into Diagnostic[].
 */
export interface LanguageChecker {
	name: string;
	/** File extensions this checker handles, including the dot. */
	extensions: readonly string[];
	/** True if the project at `cwd` looks like this language. */
	detect: (cwd: string) => Promise<boolean>;
	/** Run the checker against `files` (or the whole project) and return diagnostics. */
	run: (cwd: string, files: string[], signal?: AbortSignal) => Promise<Diagnostic[]>;
}
