import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Compose the current input in $EDITOR. Writes the buffer to a temp .md
 * file, suspends the TUI so the editor owns the terminal, runs it
 * synchronously, then resumes and returns the edited text. The TUI
 * suspend/resume is supplied by the caller (tui.stop()/start()).
 */

/** Resolve the editor command: $VISUAL → $EDITOR → vi (notepad on Windows). */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
	const spec = env.VISUAL || env.EDITOR;
	if (spec?.trim()) {
		const parts = spec.trim().split(/\s+/);
		return { cmd: parts[0], args: parts.slice(1) };
	}
	if (process.platform === "win32") return { cmd: "notepad", args: [] };
	return { cmd: "vi", args: [] };
}

export interface ExternalEditorDeps {
	/** Release the terminal so the editor can own it (e.g. tui.stop()). */
	suspend: () => void;
	/** Reclaim the terminal after the editor exits (e.g. tui.start() + redraw). */
	resume: () => void;
	/** Override the spawn (tests). Returns true on a successful exit. */
	run?: (cmd: string, args: string[]) => boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * Returns the edited text, or null if the editor couldn't run (left the
 * caller's buffer unchanged). A trailing newline is trimmed — editors add
 * one, but the input line shouldn't.
 */
export function editInExternalEditor(initial: string, deps: ExternalEditorDeps): string | null {
	const dir = mkdtempSync(join(tmpdir(), "codebase-edit-"));
	const file = join(dir, "message.md");
	try {
		writeFileSync(file, initial, "utf8");
		const { cmd, args } = resolveEditor(deps.env);
		const run = deps.run ?? defaultRun;
		deps.suspend();
		let ok: boolean;
		try {
			ok = run(cmd, [...args, file]);
		} finally {
			deps.resume();
		}
		if (!ok) return null;
		return readFileSync(file, "utf8").replace(/\n$/, "");
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function defaultRun(cmd: string, args: string[]): boolean {
	const result = spawnSync(cmd, args, { stdio: "inherit" });
	return !result.error && (result.status === 0 || result.status === null);
}
