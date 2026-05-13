import { spawn } from "node:child_process";

/**
 * Run a one-shot `!command` and append its output to the status lines.
 * This is intentionally divorced from the agent's shell tool — the
 * agent's tool is for tool-use turns, this is a CLI escape so the user
 * can `!git status` without spending a turn. Output is capped at 32 KB
 * to keep the transcript from drowning.
 */
export async function runShellEscape(command: string, cwd: string, emit: (line: string) => void): Promise<void> {
	emit(`! ${command}`);
	return new Promise<void>((resolve) => {
		const child = spawn(command, { shell: true, cwd, env: process.env });
		let buffer = "";
		const MAX = 32 * 1024;
		const onChunk = (chunk: Buffer) => {
			if (buffer.length >= MAX) return;
			buffer += chunk.toString("utf8").slice(0, MAX - buffer.length);
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("close", (code) => {
			const trimmed = buffer.trim();
			if (trimmed.length === 0) {
				emit(code === 0 ? "(no output)" : `(exit ${code})`);
			} else {
				const lines = trimmed.split("\n").slice(0, 60);
				for (const line of lines) emit(line);
				if (code !== 0) emit(`(exit ${code})`);
			}
			resolve();
		});
		child.on("error", (err) => {
			emit(`! ${err.message}`);
			resolve();
		});
	});
}
