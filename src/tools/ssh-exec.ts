import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { loadSshConfig } from "../ssh/config.js";
import { TimeoutError } from "./errors.js";
import { validateShellCommand } from "./shell-validator.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	host: Type.String({
		description:
			'Name of an enrolled SSH host (e.g. "staging"). Must match an entry in ~/.codebase/ssh.json or ./.codebase/ssh.json. NOT a user@hostname string — the agent cannot choose the destination, only name one the user has enrolled.',
	}),
	command: Type.String({
		description:
			"Command to run on the remote host. Runs through the remote shell (default user shell), so pipes and redirection work. Same caveats as the local `shell` tool — and the shell validator applies here too (rm -rf /, etc. are blocked).",
	}),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 600_000,
			description: "Kill the SSH command after this many ms. Default 60000.",
		}),
	),
});

export type SshExecParams = Static<typeof Params>;

export interface SshExecDetails {
	host: string;
	hostname: string;
	command: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	bytesTotal: number;
	timedOut: boolean;
	aborted: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const VISIBLE_CAP_BYTES = 30_000;

const DESCRIPTION = `Run a command on a remote machine via SSH.

The host must be enrolled first via \`codebase ssh add <name> <hostname>\` — the
agent can only target hosts you've enrolled, never arbitrary user@host strings.
Authentication uses the SSH key configured for the host (or your default
~/.ssh/id_* if none specified). Password prompts are disabled (BatchMode=yes)
so the call fails fast if the key isn't accepted.

Safety:
- Same shell-validator that gates the local \`shell\` tool also gates remote
  commands. \`rm -rf /\` over SSH is blocked the same way.
- StrictHostKeyChecking=accept-new: the first connection to a host pins its
  host key (TOFU); subsequent mismatches refuse to connect.
- ConnectTimeout=10s + ServerAliveInterval=30s prevent indefinite hangs.

Output: combined stdout+stderr from the remote command, capped at ~30KB.
Default timeout 60s (raise via timeout_ms, max 10 min).`;

export function createSshExec(ctx: ToolContext): AgentTool<typeof Params, SshExecDetails> {
	return {
		name: "ssh_exec",
		label: "SSH",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const config = loadSshConfig({ cwd: ctx.cwd });
			const host = config.get(params.host);
			if (!host) {
				const known = config.listNames();
				const hint =
					known.length === 0
						? "No SSH hosts enrolled. Run `codebase ssh add <name> <hostname>` to enroll one."
						: `Known hosts: ${known.join(", ")}.`;
				return {
					details: emptyDetails(params.host, "?", params.command),
					content: [{ type: "text", text: `Unknown SSH host "${params.host}". ${hint}` }],
					isError: true,
				};
			}

			// Same destructive-pattern validator that gates the local shell
			// tool. The remote shell would happily execute `rm -rf /`; the
			// validator is shell-agnostic so we apply it before any spawn.
			const verdict = validateShellCommand(params.command);
			if (verdict.verdict === "block") {
				return {
					details: emptyDetails(params.host, host.host, params.command),
					content: [
						{
							type: "text",
							text:
								`Remote command refused by the shell validator: ${verdict.reason}.\n\n` +
								"This is a hard block — the command was not executed on the remote.",
						},
					],
					isError: true,
				};
			}

			const target = host.user ? `${host.user}@${host.host}` : host.host;
			const args = buildSshArgs(host, target, params.command);
			const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const startedAt = Date.now();

			let timedOut = false;
			let aborted = false;
			const chunks: Buffer[] = [];
			let bytesTotal = 0;

			const child: ChildProcess = spawn("ssh", args, {
				stdio: ["ignore", "pipe", "pipe"],
				// Clone env so a remote command that exports vars (via ssh
				// agent forwarding etc.) can't leak back into the agent process.
				env: { ...process.env },
			});

			const stop = (kind: "timeout" | "abort"): void => {
				if (kind === "timeout") timedOut = true;
				if (kind === "abort") aborted = true;
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone — fine
				}
			};

			const addChunk = (chunk: Buffer): void => {
				bytesTotal += chunk.length;
				const remaining = VISIBLE_CAP_BYTES - chunks.reduce((s, c) => s + c.length, 0);
				if (remaining > 0) {
					chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
				}
			};

			child.stdout?.on("data", (b: Buffer) => addChunk(b));
			child.stderr?.on("data", (b: Buffer) => addChunk(b));

			const abortHandler = (): void => stop("abort");
			signal?.addEventListener("abort", abortHandler);
			const timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);

			const exit: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolveExit) => {
				child.on("error", (err) => {
					addChunk(Buffer.from(`\n[ssh error: ${err.message}]\n`, "utf8"));
					resolveExit({ code: 1, signal: null });
				});
				child.on("close", (code, sig) => resolveExit({ code, signal: sig }));
			});

			signal?.removeEventListener("abort", abortHandler);
			clearTimeout(timeoutTimer);

			const durationMs = Date.now() - startedAt;
			if (timedOut) throw new TimeoutError(Math.round(timeoutMs / 1000), "ssh_exec");

			const visible = Buffer.concat(chunks).toString("utf8");
			const truncatedNote =
				bytesTotal > VISIBLE_CAP_BYTES
					? `\n[output truncated — ${bytesTotal - VISIBLE_CAP_BYTES} bytes elided from the tail]\n`
					: "";
			const exitNote =
				exit.code === 0
					? ""
					: `\n[exit ${exit.code ?? "?"}${exit.signal ? ` ${exit.signal}` : ""}]${aborted ? " (aborted)" : ""}`;
			const text = `$ ssh ${target} -- ${params.command}\n${visible}${truncatedNote}${exitNote}`.trimEnd();

			return {
				details: {
					host: host.name,
					hostname: host.host,
					command: params.command,
					exitCode: exit.code,
					signal: exit.signal,
					durationMs,
					bytesTotal,
					timedOut,
					aborted,
				},
				content: [{ type: "text", text }],
				isError: exit.code !== 0,
			};
		},
	};
}

function buildSshArgs(host: { port?: number; identityFile?: string }, target: string, command: string): string[] {
	const args = [
		// Never prompt for a password. If the key isn't accepted, fail fast.
		"-o",
		"BatchMode=yes",
		// Cap the connection-establishment phase. Without this, an unreachable
		// host hangs for the OS-default TCP timeout (minutes).
		"-o",
		"ConnectTimeout=10",
		// Trust-on-first-use: the first connection to a hostname pins its
		// host key in known_hosts. Subsequent mismatches refuse to connect
		// (catches MITM after enrollment). Strict-from-the-start would
		// require manual `ssh-keyscan` before enrollment.
		"-o",
		"StrictHostKeyChecking=accept-new",
		// Detect dead sockets so a process surviving a network blip doesn't
		// leave us waiting for output forever.
		"-o",
		"ServerAliveInterval=30",
		"-o",
		"ServerAliveCountMax=3",
	];
	if (host.port !== undefined) {
		args.push("-p", String(host.port));
	}
	if (host.identityFile) {
		args.push("-i", expandTilde(host.identityFile));
		// When an identity file is explicitly chosen, also tell ssh NOT
		// to try the agent or other identities. Predictable auth path.
		args.push("-o", "IdentitiesOnly=yes");
	}
	args.push(target);
	// `--` ensures the remaining argument is the command, not parsed as
	// an option even if it starts with `-`. We pass it as a single
	// argument; ssh then sends it through the remote shell.
	args.push("--");
	args.push(command);
	return args;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
	return p;
}

function emptyDetails(host: string, hostname: string, command: string): SshExecDetails {
	return {
		host,
		hostname,
		command,
		exitCode: null,
		signal: null,
		durationMs: 0,
		bytesTotal: 0,
		timedOut: false,
		aborted: false,
	};
}
