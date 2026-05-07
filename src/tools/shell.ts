import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { TimeoutError } from "./errors.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	command: Type.String({
		description: "Shell command to run via /bin/sh -c (Unix) or cmd.exe /c (Windows). Pipes and redirection allowed.",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory, relative to the project root. Defaults to the project root. Must remain inside the project root.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 100,
			maximum: 600_000,
			description: "Kill the command after this many ms. Default 30000. Max 600000 (10 min).",
		}),
	),
});

export type ShellParams = Static<typeof Params>;

export interface ShellDetails {
	command: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	bytesTotal: number;
	truncated: boolean;
	spillPath: string | null;
	timedOut: boolean;
	aborted: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const VISIBLE_CAP_BYTES = 30_000;
const HEAD_RATIO = 0.6;

const DESCRIPTION = `Run a shell command. Output is streamed back as it arrives so long-running commands surface progress immediately.

Behavior:
- Runs through the platform shell (sh -c on Unix, cmd /c on Windows) so pipes and redirection work.
- Output is captured combined (stdout + stderr in source order). Up to ~30 KB is shown to you; anything beyond is written to a temp file whose path is reported in the result so you can read selectively.
- Default timeout is 30 seconds; raise via timeout_ms (max 10 minutes). On timeout you'll see "command timed out".
- The cwd defaults to the project root. Set cwd if the command needs to run elsewhere within the project.
- Aborting the agent (Ctrl-C) propagates to the running command via SIGTERM.

Permission gating: write/destructive shell commands are gated by a hook before reaching this tool. Read-only commands (ls, cat, grep, rg, git log, npm test, etc.) bypass the gate.`;

export function createShell(ctx: ToolContext): AgentTool<typeof Params, ShellDetails> {
	return {
		name: "shell",
		label: "Shell",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate) => {
			const cwd = resolveSubCwd(ctx.cwd, params.cwd);
			const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const startedAt = Date.now();

			const acc = new OutputAccumulator();
			let timedOut = false;
			let aborted = false;
			let updateTimer: NodeJS.Timeout | undefined;
			let lastUpdateAt = 0;

			const child: ChildProcess = spawn(params.command, {
				shell: true,
				cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});

			const flushUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdateAt < 100) return;
				lastUpdateAt = now;
				const visible = acc.visible(VISIBLE_CAP_BYTES);
				onUpdate(buildPartial(params.command, visible.text, acc.size()));
			};

			const stop = (kind: "timeout" | "abort") => {
				if (kind === "timeout") timedOut = true;
				if (kind === "abort") aborted = true;
				killProcess(child);
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				acc.add(chunk);
				scheduleUpdate();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				acc.add(chunk);
				scheduleUpdate();
			});

			function scheduleUpdate(): void {
				if (!onUpdate || updateTimer) return;
				updateTimer = setTimeout(() => {
					updateTimer = undefined;
					flushUpdate();
				}, 100);
			}

			const abortHandler = () => stop("abort");
			signal?.addEventListener("abort", abortHandler);

			const timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);

			const exit: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolveExit) => {
				child.on("error", (err) => {
					acc.add(Buffer.from(`\n[shell error: ${err.message}]\n`, "utf8"));
					resolveExit({ code: 1, signal: null });
				});
				child.on("close", (code, sig) => resolveExit({ code, signal: sig }));
			});

			signal?.removeEventListener("abort", abortHandler);
			clearTimeout(timeoutTimer);
			if (updateTimer) clearTimeout(updateTimer);

			const durationMs = Date.now() - startedAt;
			const visible = acc.visible(VISIBLE_CAP_BYTES);
			const spillPath = visible.truncated ? spillToFile(toolCallId, acc.full()) : null;

			if (timedOut) {
				throw new TimeoutError(Math.round(timeoutMs / 1000), "shell");
			}

			const summary = formatSummary(visible.text, exit, durationMs, acc.size(), spillPath, aborted);

			return {
				content: [{ type: "text", text: summary }],
				details: {
					command: params.command,
					exitCode: exit.code,
					signal: exit.signal,
					durationMs,
					bytesTotal: acc.size(),
					truncated: visible.truncated,
					spillPath,
					timedOut,
					aborted,
				},
			};
		},
	};
}

function resolveSubCwd(projectCwd: string, requested: string | undefined): string {
	if (!requested) return resolve(projectCwd);
	const abs = resolve(projectCwd, requested);
	if (abs !== resolve(projectCwd) && !abs.startsWith(`${resolve(projectCwd)}/`)) {
		throw new Error(`cwd ${requested} is outside the project root.`);
	}
	return abs;
}

function killProcess(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		if (process.platform !== "win32") {
			// Negative pid kills the entire process group spawned via detached:true.
			process.kill(-child.pid, "SIGTERM");
		} else {
			child.kill("SIGTERM");
		}
	} catch {
		// already exited
	}
}

function spillToFile(toolCallId: string, full: Buffer): string {
	const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || randomBytes(4).toString("hex");
	const path = join(tmpdir(), `codebase-shell-${safeId}-${Date.now()}.log`);
	writeFileSync(path, full);
	return path;
}

function formatSummary(
	visible: string,
	exit: { code: number | null; signal: NodeJS.Signals | null },
	durationMs: number,
	bytesTotal: number,
	spillPath: string | null,
	aborted: boolean,
): string {
	const lines: string[] = [];
	lines.push(visible);
	lines.push("");
	const exitLabel = aborted ? "aborted" : exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code ?? "?"}`;
	lines.push(`[${exitLabel} in ${durationMs}ms; ${bytesTotal} bytes total]`);
	if (spillPath) {
		lines.push(`[full output spilled to ${spillPath}]`);
	}
	return lines.join("\n");
}

function buildPartial(command: string, visible: string, bytesTotal: number) {
	return {
		content: [{ type: "text" as const, text: visible }],
		details: {
			command,
			exitCode: null,
			signal: null,
			durationMs: 0,
			bytesTotal,
			truncated: false,
			spillPath: null,
			timedOut: false,
			aborted: false,
		},
	};
}

/**
 * Buffers stdout/stderr chunks. Tracks total bytes so we can decide when to
 * spill, and produces a head+tail visible slice when over budget.
 */
export class OutputAccumulator {
	private chunks: Buffer[] = [];
	private totalBytes = 0;

	add(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.totalBytes += chunk.length;
	}

	size(): number {
		return this.totalBytes;
	}

	full(): Buffer {
		return Buffer.concat(this.chunks);
	}

	visible(cap: number): { text: string; truncated: boolean } {
		const all = this.full();
		if (all.length <= cap) {
			return { text: all.toString("utf8"), truncated: false };
		}
		const headSize = Math.floor(cap * HEAD_RATIO);
		const noticeStart = `\n…[${all.length - cap} bytes truncated]…\n`;
		const tailSize = cap - headSize - Buffer.byteLength(noticeStart, "utf8");
		const head = all.subarray(0, headSize).toString("utf8");
		const tail = tailSize > 0 ? all.subarray(all.length - tailSize).toString("utf8") : "";
		return { text: head + noticeStart + tail, truncated: true };
	}
}

// Suppress unused-callback type narrowing in older toolchains.
export type ShellOnUpdate = AgentToolUpdateCallback<ShellDetails>;
