import { spawn } from "node:child_process";

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Spawn `git` with the given args. Returns a Promise that resolves with
 * captured stdout, stderr, and exit code. Never throws — caller decides
 * whether non-zero is an error in their context.
 */
export function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
	return new Promise((resolveRun) => {
		const child = spawn("git", args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (b: Buffer) => out.push(b));
		child.stderr?.on("data", (b: Buffer) => err.push(b));
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort);
		child.on("error", (e) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({ stdout: "", stderr: e.message, exitCode: 1 });
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolveRun({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				exitCode: code ?? 1,
			});
		});
	});
}

/** True if cwd is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
	return r.exitCode === 0 && r.stdout.trim() === "true";
}

/** Throws an actionable error if cwd is not a git repo. */
export async function requireGitRepo(cwd: string): Promise<void> {
	if (!(await isGitRepo(cwd))) {
		throw new Error(`Not a git repository (or any parent): ${cwd}`);
	}
}
