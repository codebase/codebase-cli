import { type ChildProcess, spawn } from "node:child_process";
import type { HookConfig, HookEventContext, HookResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a single hook command. Sends the event payload as JSON on stdin so
 * shell hooks can `jq` whatever fields they care about. Never throws —
 * spawn/timeout failures come back as a non-zero exit code with stderr
 * populated, so the manager can decide how to react.
 */
export function runHook(config: HookConfig, context: HookEventContext, signal?: AbortSignal): Promise<HookResult> {
	return new Promise((resolve) => {
		const timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
		let settled = false;
		const finish = (result: HookResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let child: ChildProcess;
		try {
			child = spawn(config.command, {
				shell: true,
				cwd: context.workingDir,
				// Clone instead of passing process.env directly — a hook that
				// does `export FOO=bar` would otherwise mutate the agent's
				// own environment for every subsequent spawn.
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			finish({ exitCode: 1, stdout: "", stderr: `hook spawn failed: ${reason}` });
			return;
		}

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish({
				exitCode: 1,
				stdout: "",
				stderr: `hook timed out after ${Math.round(timeoutMs / 1000)}s`,
			});
		}, timeoutMs);

		const onAbort = () => {
			// Send SIGTERM, then resolve so callers waiting on us aren't
			// stuck if the child (or its shell wrapper) doesn't propagate
			// the signal. With shell:true the signal lands on sh, not
			// necessarily on the child it spawned, so we can't trust the
			// `close` event to arrive.
			try {
				child.kill("SIGTERM");
			} catch {
				// best-effort
			}
			finish({ exitCode: 1, stdout: "", stderr: "hook aborted" });
		};
		signal?.addEventListener("abort", onAbort);

		try {
			child.stdin?.write(JSON.stringify(context));
			child.stdin?.end();
		} catch {
			// stdin already closed by a fast exit — that's fine
		}

		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (b: Buffer) => out.push(b));
		child.stderr?.on("data", (b: Buffer) => err.push(b));

		child.on("error", (e) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			finish({ exitCode: 1, stdout: "", stderr: e.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			finish({
				exitCode: code ?? 1,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
	});
}
