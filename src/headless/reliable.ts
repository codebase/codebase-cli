import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { CheckpointEntry } from "../checkpoint/store.js";
import type { Task } from "../tools/task-store.js";

export const RELIABLE_MODE_PROMPT = `# Reliable mode

This headless run is being audited for reliability. Treat the user's request as work that must be proven, not just attempted.

Rules:
- Use create_task/update_task for any non-trivial work. Keep exactly one task in_progress at a time.
- Do not mark a task completed until its work is actually done.
- Run a meaningful verification command before the final answer (tests, build, lint, typecheck, or a project-specific verify script).
- If verification fails, fix the underlying issue and run verification again.
- In the final answer, name the verification command that passed.`;

export interface ReceiptToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	details?: Record<string, unknown>;
}

export interface VerificationEvidence {
	toolCallId: string;
	command: string;
	exitCode: number;
	durationMs?: number;
}

export interface ReliabilityReceipt {
	mode: "reliable";
	ok: boolean;
	summary: {
		taskCount: number;
		completedTasks: number;
		openTasks: number;
		cancelledTasks: number;
		toolCalls: number;
		failedToolCalls: number;
		verificationCount: number;
		checkpoints: number;
		durationMs: number;
	};
	tasks: Task[];
	tools: ReceiptToolCall[];
	verification: VerificationEvidence[];
	checkpoints: Pick<CheckpointEntry, "seq" | "display" | "tool" | "existed" | "tooLarge" | "timestamp">[];
	failures: string[];
	warnings: string[];
}

export class ReliabilityRecorder {
	private readonly tools = new Map<string, ReceiptToolCall>();

	record(event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			this.tools.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: summarizeArgs(event.toolName, event.args),
				status: "running",
				startedAt: Date.now(),
			});
			return;
		}
		if (event.type !== "tool_execution_end") return;
		const existing =
			this.tools.get(event.toolCallId) ??
			({
				id: event.toolCallId,
				name: event.toolName,
				args: {},
				status: "running",
				startedAt: Date.now(),
			} satisfies ReceiptToolCall);
		const endedAt = Date.now();
		this.tools.set(event.toolCallId, {
			...existing,
			status: event.isError ? "error" : "done",
			endedAt,
			durationMs: Math.max(0, endedAt - existing.startedAt),
			details: summarizeResult(event.toolName, event.result),
		});
	}

	build(input: { tasks: Task[]; checkpoints: readonly CheckpointEntry[]; durationMs: number }): ReliabilityReceipt {
		const tasks = [...input.tasks];
		const tools = Array.from(this.tools.values());
		const failedToolCalls = tools.filter((t) => t.status === "error").length;
		const openTasks = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
		const completedTasks = tasks.filter((t) => t.status === "completed");
		const cancelledTasks = tasks.filter((t) => t.status === "cancelled");
		const verification = collectVerification(tools);
		const failures: string[] = [];
		const warnings: string[] = [];

		if (tasks.length === 0) failures.push("no task list was created");
		if (tasks.length > 0 && completedTasks.length === 0) failures.push("no tasks were completed");
		if (openTasks.length > 0) failures.push(`open tasks remain: ${openTasks.map((t) => t.id).join(", ")}`);
		if (verification.length === 0) failures.push("no successful verification command was recorded");
		if (failedToolCalls > 0)
			warnings.push(`${failedToolCalls} tool call${failedToolCalls === 1 ? "" : "s"} failed before the run ended`);

		return {
			mode: "reliable",
			ok: failures.length === 0,
			summary: {
				taskCount: tasks.length,
				completedTasks: completedTasks.length,
				openTasks: openTasks.length,
				cancelledTasks: cancelledTasks.length,
				toolCalls: tools.length,
				failedToolCalls,
				verificationCount: verification.length,
				checkpoints: input.checkpoints.length,
				durationMs: input.durationMs,
			},
			tasks,
			tools,
			verification,
			checkpoints: input.checkpoints.map((entry) => ({
				seq: entry.seq,
				display: entry.display,
				tool: entry.tool,
				existed: entry.existed,
				tooLarge: entry.tooLarge,
				timestamp: entry.timestamp,
			})),
			failures,
			warnings,
		};
	}
}

export function formatReliabilityFailure(receipt: ReliabilityReceipt): string {
	if (receipt.ok) return "Reliable mode passed.";
	return `Reliable mode failed: ${receipt.failures.join("; ")}.`;
}

function collectVerification(tools: ReceiptToolCall[]): VerificationEvidence[] {
	const evidence: VerificationEvidence[] = [];
	for (const tool of tools) {
		if (tool.name !== "shell" || tool.status !== "done") continue;
		const command = typeof tool.details?.command === "string" ? tool.details.command : undefined;
		const exitCode = typeof tool.details?.exitCode === "number" ? tool.details.exitCode : undefined;
		if (!command || exitCode !== 0 || !isVerificationCommand(command)) continue;
		evidence.push({
			toolCallId: tool.id,
			command,
			exitCode,
			durationMs: typeof tool.details?.durationMs === "number" ? tool.details.durationMs : undefined,
		});
	}
	return evidence;
}

export function isVerificationCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	const patterns = [
		/\bnpm\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\bpnpm\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\byarn\s+(test|run\s+(test|check|lint|build|typecheck|verify)|check|lint|build|typecheck)\b/,
		/\bbun\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\b(vitest|jest|pytest|ruff|eslint|tsc)\b/,
		/\b(go test|cargo test|cargo clippy|mvn test|gradle test|swift test|zig build test)\b/,
		/\b(make|just)\s+(test|check|verify|lint|build)\b/,
		/(^|[ /])verify\.sh\b/,
	];
	return patterns.some((pattern) => pattern.test(normalized));
}

function summarizeArgs(toolName: string, args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return {};
	const input = args as Record<string, unknown>;
	if (toolName === "shell") {
		return pick(input, ["command", "cwd", "timeout_ms", "background"]);
	}
	if (toolName === "create_task") {
		return pick(input, ["title", "active_form", "owner", "blocked_by"]);
	}
	if (toolName === "update_task") {
		return pick(input, ["id", "status", "title", "owner", "clear_owner", "add_blocks", "add_blocked_by"]);
	}
	if (toolName === "write_file") {
		return { ...pick(input, ["path"]), contentBytes: byteLength(input.content) };
	}
	if (toolName === "edit_file") {
		return {
			...pick(input, ["path"]),
			oldBytes: byteLength(input.old_string),
			newBytes: byteLength(input.new_string),
		};
	}
	if (toolName === "multi_edit") {
		const edits = Array.isArray(input.edits) ? input.edits.length : undefined;
		return { ...pick(input, ["path"]), edits };
	}
	return pick(input, ["path", "id", "status", "command", "message"]);
}

function summarizeResult(toolName: string, result: unknown): Record<string, unknown> {
	if (!result || typeof result !== "object") return {};
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return {};
	const input = details as Record<string, unknown>;
	if (toolName === "shell") {
		return pick(input, [
			"command",
			"exitCode",
			"signal",
			"durationMs",
			"bytesTotal",
			"truncated",
			"spillPath",
			"timedOut",
			"aborted",
			"backgroundId",
		]);
	}
	if (toolName === "git_commit") {
		return pick(input, ["sha", "subject", "branch"]);
	}
	if (toolName.endsWith("_task") || toolName === "create_task" || toolName === "update_task") {
		return pick(input, ["id", "title", "status", "owner", "blocks", "blockedBy"]);
	}
	return {};
}

function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (input[key] !== undefined) out[key] = input[key];
	}
	return out;
}

function byteLength(value: unknown): number | undefined {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined;
}
