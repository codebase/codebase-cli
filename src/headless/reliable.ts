import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { CheckpointEntry } from "../checkpoint/store.js";
import { redactSecrets } from "../memory/secrets.js";
import type { Task, TaskStatus } from "../tools/task-store.js";

const MUTATING_FILE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);
const TASK_TOOL_NAMES = new Set(["create_task", "update_task", "list_tasks", "get_task"]);

export const RELIABLE_MODE_PROMPT = `# Reliable mode

This headless run is being audited for reliability. Treat the user's request as work that must be proven, not just attempted.

Rules:
- In reliable mode, always use create_task/update_task, even for simple, read-only, or memory-only work. Keep exactly one task in_progress at a time.
- Move a task to in_progress before using non-task tools for that task.
- Do not mark a task completed until its work is actually done.
- Make completed tasks auditable: while each task is in_progress, use tools that leave evidence (file reads/writes, shell commands, searches, or other relevant tool calls).
- For code or file changes, track verification as task work: either keep the implementation task in_progress until verification passes, or create a separate verification task and run the check while that task is in_progress.
- For code or file changes, run a meaningful verification command after the final file change and before the final answer (tests, build, lint, typecheck, smoke run, or a project-specific verify script).
- Do not make verification commands pass by masking failures with fallbacks like "|| true" or "|| echo".
- If verification fails, fix the underlying issue and run verification again.
- For code or file changes, name the fresh passing verification command in the final answer.
- For read-only or memory-only work, keep the task lifecycle auditable and state that no file-change verification was needed.`;

export interface ReceiptToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	order: number;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	details?: Record<string, unknown>;
}

export interface VerificationEvidence {
	toolCallId: string;
	command: string;
	exitCode: number;
	order: number;
	startedAt: number;
	endedAt: number;
	durationMs?: number;
}

export interface MutationEvidence {
	toolCallId: string;
	tool: string;
	path?: string;
	order: number;
	startedAt: number;
	endedAt: number;
	checkpoints: Array<Pick<CheckpointEntry, "seq" | "display" | "timestamp">>;
}

export interface TaskLifecycleEvidence {
	id: string;
	title?: string;
	transitions: Array<{
		toolCallId: string;
		status: TaskStatus;
		order: number;
		at: number;
	}>;
}

export interface TaskEvidence {
	id: string;
	title: string;
	status: TaskStatus;
	activeFrom?: number;
	completedAt?: number;
	toolCalls: Array<
		Pick<ReceiptToolCall, "id" | "name" | "args" | "status" | "order" | "startedAt" | "endedAt" | "durationMs">
	>;
	mutations: MutationEvidence[];
	verification: VerificationEvidence[];
}

export interface FinalAnswerEvidence {
	mentionsFreshVerification: boolean;
	matchedVerificationCommands: string[];
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
		mutationCount: number;
		verificationCount: number;
		verificationAfterLastMutationCount: number;
		completedTasksWithEvidence: number;
		completedTasksWithVerification: number;
		finalAnswerMentionsFreshVerification: boolean;
		checkpoints: number;
		durationMs: number;
	};
	tasks: Task[];
	taskLifecycle: TaskLifecycleEvidence[];
	taskEvidence: TaskEvidence[];
	tools: ReceiptToolCall[];
	mutations: MutationEvidence[];
	verification: VerificationEvidence[];
	finalAnswer: FinalAnswerEvidence;
	checkpoints: Pick<CheckpointEntry, "seq" | "display" | "tool" | "existed" | "tooLarge" | "timestamp">[];
	failures: string[];
	warnings: string[];
}

export class ReliabilityRecorder {
	private readonly tools = new Map<string, ReceiptToolCall>();
	private nextOrder = 1;

	record(event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			this.tools.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: summarizeArgs(event.toolName, event.args),
				status: "running",
				order: this.nextOrder++,
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
				order: this.nextOrder++,
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

	build(input: {
		tasks: Task[];
		checkpoints: readonly CheckpointEntry[];
		durationMs: number;
		finalText: string;
	}): ReliabilityReceipt {
		const tasks = [...input.tasks];
		const tools = Array.from(this.tools.values());
		const failedToolCalls = tools.filter((t) => t.status === "error").length;
		const openTasks = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
		const completedTasks = tasks.filter((t) => t.status === "completed");
		const cancelledTasks = tasks.filter((t) => t.status === "cancelled");
		const verification = collectVerification(tools);
		const lifecycle = analyzeTaskLifecycle(tools);
		const mutations = collectMutations(tools, input.checkpoints);
		const lastMutation = mutations[mutations.length - 1];
		const verificationAfterLastMutation = lastMutation
			? verification.filter((item) => happenedAfter(item, lastMutation))
			: verification;
		const finalAnswer = collectFinalAnswerEvidence(input.finalText, verificationAfterLastMutation);
		const taskEvidence = collectTaskEvidence(tasks, lifecycle.tasks, tools, mutations, verification);
		const completedTasksWithEvidence = taskEvidence.filter(
			(item) => item.status === "completed" && hasTaskEvidence(item),
		);
		const completedTasksWithoutEvidence = taskEvidence.filter(
			(item) => item.status === "completed" && !hasTaskEvidence(item),
		);
		const completedTasksWithVerification = taskEvidence.filter(
			(item) => item.status === "completed" && item.verification.length > 0,
		);
		const failures: string[] = [];
		const warnings: string[] = [];

		if (tasks.length === 0) failures.push("no task list was created");
		if (tasks.length > 0 && completedTasks.length === 0) failures.push("no tasks were completed");
		if (openTasks.length > 0) failures.push(`open tasks remain: ${openTasks.map((t) => t.id).join(", ")}`);
		if (mutations.length > 0 && verification.length === 0) {
			failures.push("no successful verification command was recorded");
		}
		if (verification.length > 0 && completedTasksWithVerification.length === 0) {
			failures.push("no completed task captured verification evidence");
		}
		if (mutations.length > 0 && verification.length > 0 && verificationAfterLastMutation.length === 0) {
			failures.push("successful verification ran before the last file mutation");
		}
		if (mutations.length > 0 && verificationAfterLastMutation.length > 0 && !finalAnswer.mentionsFreshVerification) {
			failures.push(
				`final answer did not name a fresh passing verification command: ${verificationAfterLastMutation.map((item) => item.command).join(", ")}`,
			);
		}
		if (completedTasksWithoutEvidence.length > 0) {
			failures.push(
				`completed task${completedTasksWithoutEvidence.length === 1 ? "" : "s"} lacked evidence: ${completedTasksWithoutEvidence.map((item) => item.id).join(", ")}`,
			);
		}
		if (lifecycle.completedWithoutInProgress.length > 0) {
			failures.push(
				`completed task${lifecycle.completedWithoutInProgress.length === 1 ? "" : "s"} skipped in_progress: ${lifecycle.completedWithoutInProgress.join(", ")}`,
			);
		}
		if (lifecycle.activeOverlaps.length > 0) {
			warnings.push(`multiple tasks were in_progress at once: ${lifecycle.activeOverlaps[0]?.join(", ")}`);
		}
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
				mutationCount: mutations.length,
				verificationCount: verification.length,
				verificationAfterLastMutationCount: verificationAfterLastMutation.length,
				completedTasksWithEvidence: completedTasksWithEvidence.length,
				completedTasksWithVerification: completedTasksWithVerification.length,
				finalAnswerMentionsFreshVerification: finalAnswer.mentionsFreshVerification,
				checkpoints: input.checkpoints.length,
				durationMs: input.durationMs,
			},
			tasks,
			taskLifecycle: lifecycle.tasks,
			taskEvidence,
			tools,
			mutations,
			verification,
			finalAnswer,
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

function collectFinalAnswerEvidence(finalText: string, freshVerification: VerificationEvidence[]): FinalAnswerEvidence {
	const matchedVerificationCommands = freshVerification
		.map((item) => item.command)
		.filter((command) => mentionsCommand(finalText, command));
	return {
		mentionsFreshVerification: matchedVerificationCommands.length > 0,
		matchedVerificationCommands,
	};
}

interface TaskLifecycleAnalysis {
	tasks: TaskLifecycleEvidence[];
	completedWithoutInProgress: string[];
	activeOverlaps: string[][];
}

function analyzeTaskLifecycle(tools: ReceiptToolCall[]): TaskLifecycleAnalysis {
	const byId = new Map<string, TaskLifecycleEvidence>();
	const statuses = new Map<string, TaskStatus>();
	const active = new Set<string>();
	const activeOverlaps: string[][] = [];

	for (const tool of [...tools].sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))) {
		const status = taskStatusFromTool(tool);
		if (!status) continue;
		const id = taskIdFromTool(tool);
		if (!id) continue;
		const evidence = byId.get(id) ?? {
			id,
			title: typeof tool.details?.title === "string" ? tool.details.title : undefined,
			transitions: [],
		};
		if (!evidence.title && typeof tool.details?.title === "string") evidence.title = tool.details.title;
		evidence.transitions.push({ toolCallId: tool.id, status, order: tool.order, at: tool.endedAt ?? tool.startedAt });
		byId.set(id, evidence);

		if (statuses.get(id) === status && tool.name !== "create_task") continue;
		statuses.set(id, status);
		if (status === "in_progress") {
			const overlap = [...active].filter((activeId) => activeId !== id);
			if (overlap.length > 0) activeOverlaps.push([...overlap, id]);
			active.add(id);
		} else {
			active.delete(id);
		}
	}
	const completedWithoutInProgress = [...byId.values()]
		.filter((item) => lastCompletedSkippedInProgress(item.transitions))
		.map((item) => item.id);

	return {
		tasks: [...byId.values()].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)),
		completedWithoutInProgress: [...new Set(completedWithoutInProgress)],
		activeOverlaps: activeOverlaps.map((ids) => [...new Set(ids)]),
	};
}

function lastCompletedSkippedInProgress(transitions: TaskLifecycleEvidence["transitions"]): boolean {
	const sorted = [...transitions].sort((a, b) => a.order - b.order);
	let lastCompletedIndex = -1;
	for (let i = sorted.length - 1; i >= 0; i--) {
		if (sorted[i]?.status === "completed") {
			lastCompletedIndex = i;
			break;
		}
	}
	if (lastCompletedIndex === -1) return false;
	return !sorted.slice(0, lastCompletedIndex).some((transition) => transition.status === "in_progress");
}

interface TaskActiveInterval {
	startOrder: number;
	endOrder: number;
	startedAt: number;
	endedAt?: number;
}

function collectTaskEvidence(
	tasks: Task[],
	lifecycle: TaskLifecycleEvidence[],
	tools: ReceiptToolCall[],
	mutations: MutationEvidence[],
	verification: VerificationEvidence[],
): TaskEvidence[] {
	const lifecycleById = new Map(lifecycle.map((item) => [item.id, item]));
	const workTools = sortedTools(tools).filter((tool) => !TASK_TOOL_NAMES.has(tool.name));
	return tasks.map((task) => {
		const intervals = activeIntervals(lifecycleById.get(task.id)?.transitions ?? []);
		const toolCalls = workTools.filter((tool) => intervals.some((interval) => withinInterval(tool.order, interval)));
		const taskMutations = mutations.filter((mutation) =>
			intervals.some((interval) => withinInterval(mutation.order, interval)),
		);
		const taskVerification = verification.filter((item) =>
			intervals.some((interval) => withinInterval(item.order, interval)),
		);
		const completedTransition = lastTransition(lifecycleById.get(task.id)?.transitions ?? [], "completed");
		return {
			id: task.id,
			title: task.title,
			status: task.status,
			...(intervals[0] ? { activeFrom: intervals[0].startedAt } : {}),
			...(completedTransition ? { completedAt: completedTransition.at } : {}),
			toolCalls: toolCalls.map((tool) => ({
				id: tool.id,
				name: tool.name,
				args: tool.args,
				status: tool.status,
				order: tool.order,
				startedAt: tool.startedAt,
				...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
				...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
			})),
			mutations: taskMutations,
			verification: taskVerification,
		};
	});
}

function activeIntervals(transitions: TaskLifecycleEvidence["transitions"]): TaskActiveInterval[] {
	const intervals: TaskActiveInterval[] = [];
	let active: TaskActiveInterval | null = null;
	for (const transition of [...transitions].sort((a, b) => a.order - b.order)) {
		if (transition.status === "in_progress") {
			if (!active) {
				active = {
					startOrder: transition.order,
					endOrder: Number.POSITIVE_INFINITY,
					startedAt: transition.at,
				};
			}
			continue;
		}
		if (active) {
			intervals.push({ ...active, endOrder: transition.order, endedAt: transition.at });
			active = null;
		}
	}
	if (active) intervals.push(active);
	return intervals;
}

function lastTransition(
	transitions: TaskLifecycleEvidence["transitions"],
	status: TaskStatus,
): TaskLifecycleEvidence["transitions"][number] | undefined {
	for (let i = transitions.length - 1; i >= 0; i--) {
		if (transitions[i]?.status === status) return transitions[i];
	}
	return undefined;
}

function withinInterval(order: number, interval: TaskActiveInterval): boolean {
	return order > interval.startOrder && order < interval.endOrder;
}

function hasTaskEvidence(item: TaskEvidence): boolean {
	return (
		item.mutations.length > 0 || item.verification.length > 0 || item.toolCalls.some((tool) => tool.status === "done")
	);
}

function collectMutations(tools: ReceiptToolCall[], checkpoints: readonly CheckpointEntry[]): MutationEvidence[] {
	const matchedCheckpointSeqs = new Set<number>();
	const sortedCheckpoints = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
	const mutations: MutationEvidence[] = [];

	for (const tool of sortedTools(tools)) {
		if (!MUTATING_FILE_TOOLS.has(tool.name) || tool.status !== "done") continue;
		const endedAt = tool.endedAt ?? tool.startedAt;
		const matched = sortedCheckpoints.filter((checkpoint) => {
			if (matchedCheckpointSeqs.has(checkpoint.seq)) return false;
			if (checkpoint.tool !== tool.name) return false;
			return checkpoint.timestamp >= tool.startedAt && checkpoint.timestamp <= endedAt;
		});
		for (const checkpoint of matched) matchedCheckpointSeqs.add(checkpoint.seq);
		mutations.push({
			toolCallId: tool.id,
			tool: tool.name,
			path: typeof tool.args.path === "string" ? tool.args.path : undefined,
			order: tool.order,
			startedAt: tool.startedAt,
			endedAt,
			checkpoints: matched.map((checkpoint) => ({
				seq: checkpoint.seq,
				display: checkpoint.display,
				timestamp: checkpoint.timestamp,
			})),
		});
	}

	return mutations.sort(compareEvidence);
}

function happenedAfter(
	later: Pick<VerificationEvidence, "endedAt" | "order">,
	earlier: Pick<MutationEvidence, "endedAt" | "order">,
): boolean {
	if (later.endedAt !== earlier.endedAt) return later.endedAt > earlier.endedAt;
	return later.order > earlier.order;
}

function compareEvidence(
	a: Pick<MutationEvidence, "endedAt" | "order">,
	b: Pick<MutationEvidence, "endedAt" | "order">,
): number {
	if (a.endedAt !== b.endedAt) return a.endedAt - b.endedAt;
	return a.order - b.order;
}

function taskStatusFromTool(tool: ReceiptToolCall): TaskStatus | undefined {
	if (tool.name === "create_task") return "pending";
	if (tool.name !== "update_task") return undefined;
	const requested = tool.args.status;
	return isTaskStatus(requested) ? requested : undefined;
}

function taskIdFromTool(tool: ReceiptToolCall): string | undefined {
	const detailId = tool.details?.id;
	if (typeof detailId === "string" && detailId.trim()) return detailId;
	const argId = tool.args.id;
	return typeof argId === "string" && argId.trim() ? argId : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function taskNumber(id: string): number {
	const match = /^task-(\d+)$/.exec(id);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function formatReliabilityFailure(receipt: ReliabilityReceipt): string {
	if (receipt.ok) return "Reliable mode passed.";
	return `Reliable mode failed: ${receipt.failures.join("; ")}.`;
}

export function formatReliabilityRepairPrompt(receipt: ReliabilityReceipt): string {
	const lines = [
		"<system-reminder>",
		"Reliable mode receipt audit failed. Before giving the final answer, fix the receipt gaps below.",
		"",
		"Receipt failures:",
		...receipt.failures.map((failure) => `- ${failure}`),
		"",
		"Repair rules:",
		"- Do not undo correct work.",
		"- If no task list exists, create a verification/finalization task, set it in_progress, do the missing auditable work, then complete it.",
		"- If failures name existing task ids that lacked evidence or skipped in_progress, repair those exact tasks. Do not create replacement tasks for them.",
		"- To repair an existing task, update that task id to in_progress, perform relevant auditable work for that task, then update that same task id to completed before moving on.",
		"- If verification is missing for file changes, run a meaningful passing command now while a task is in_progress.",
		"- Do not use fallbacks that hide failure, such as `|| true` or `|| echo`.",
		"- If the final answer missed proof, include the exact fresh passing command string in the final answer.",
		"- If there were no file changes, state that no file-change verification was needed.",
		"</system-reminder>",
	];
	return lines.join("\n");
}

function collectVerification(tools: ReceiptToolCall[]): VerificationEvidence[] {
	const evidence: VerificationEvidence[] = [];
	for (const tool of sortedTools(tools)) {
		if (tool.name !== "shell" || tool.status !== "done") continue;
		const command = typeof tool.details?.command === "string" ? tool.details.command : undefined;
		const exitCode = typeof tool.details?.exitCode === "number" ? tool.details.exitCode : undefined;
		if (!command || exitCode !== 0 || !isVerificationCommand(command)) continue;
		evidence.push({
			toolCallId: tool.id,
			command,
			exitCode,
			order: tool.order,
			startedAt: tool.startedAt,
			endedAt: tool.endedAt ?? tool.startedAt,
			durationMs: typeof tool.details?.durationMs === "number" ? tool.details.durationMs : undefined,
		});
	}
	return evidence;
}

function sortedTools(tools: ReceiptToolCall[]): ReceiptToolCall[] {
	return [...tools].sort((a, b) => {
		const aTime = a.endedAt ?? a.startedAt;
		const bTime = b.endedAt ?? b.startedAt;
		if (aTime !== bTime) return aTime - bTime;
		return a.order - b.order;
	});
}

function mentionsCommand(text: string, command: string): boolean {
	const haystack = normalizeCommandText(text);
	for (const needle of commandMentionCandidates(command)) {
		if (!needle) continue;
		let index = haystack.indexOf(needle);
		while (index !== -1) {
			const before = haystack.slice(Math.max(0, index - 90), index);
			const after = haystack.slice(index + needle.length, index + needle.length + 90);
			if (!isNegatedCommandMention(before, after)) return true;
			index = haystack.indexOf(needle, index + needle.length);
		}
	}
	return false;
}

function commandMentionCandidates(command: string): string[] {
	const full = normalizeCommandText(command);
	const candidates = new Set<string>([full]);
	const withoutRedirection = stripHarmlessShellRedirection(full);
	if (withoutRedirection !== full) candidates.add(withoutRedirection);
	for (const part of full.split(/\s+(?:&&|\|\||;)\s+/)) {
		const candidate = part.trim();
		if (candidate && candidate !== full && isVerificationCommand(candidate)) candidates.add(candidate);
		const stripped = stripHarmlessShellRedirection(candidate);
		if (stripped && stripped !== candidate && isVerificationCommand(stripped)) candidates.add(stripped);
	}
	return [...candidates].sort((a, b) => b.length - a.length);
}

function normalizeCommandText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripHarmlessShellRedirection(command: string): string {
	return command
		.replace(/\s+\d?>&\d+\b/g, "")
		.replace(/\s+\d?>(?:\/dev\/null|nul)\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function isNegatedCommandMention(before: string, after: string): boolean {
	if (
		/(^|[\s.;:,(])(?:did not|didn't|do not|don't|never|not|without|skipped|could not|couldn't|cannot|can't|unable to|failed to)\s+(?:successfully\s+)?(?:run|ran|execute|executed|verify|verified|rerun|re-run|use|used)?\s*$/.test(
			before,
		)
	) {
		return true;
	}
	return /^(?:[\s`'".,:;)-]*)(?:was|is|did|does|had)?\s*(?:not|never|failed|failing|fail|missing|skipped|unverified|not run|not pass|didn't pass|did not pass|wasn't run|was not run)\b/.test(
		after,
	);
}

export function isVerificationCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	if (/\|\|\s*(?::|true|echo)\b/.test(normalized)) return false;
	if (/^(?:which|command\s+-v)\b/.test(normalized)) return false;
	const patterns = [
		/\bnpm\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\bpnpm\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\byarn\s+(test|run\s+(test|check|lint|build|typecheck|verify)|check|lint|build|typecheck)\b/,
		/\bbun\s+(test|run\s+(test|check|lint|build|typecheck|verify))\b/,
		/\b(vitest|jest|pytest|ruff|eslint|tsc)\b/,
		/\bdeno\s+(test|check|lint)\b/,
		/\bnode\s+--test\b/,
		/\bnode(?:\s+--[\w=-]+)*\s+-e\b[\s\S]*(?:from\s+['"]\.\/|import\(['"]\.\/|require\(['"]\.\/|src\/)/,
		/\bnode(?:\s+--[\w=-]+)*\s+(?:[\w./-]*\/)?[\w.-]*(?:test|spec|verify|check)[\w.-]*\.[cm]?[jt]s\b/,
		/\bnpx(?:\s+-[\w-]+(?:=\S+)?)*\s+typescript(?:@[\w.-]+)?\b(?=.*\s--noemit\b)(?=.*\.[cm]?tsx?\b)/,
		/\b(?:npx(?:\s+-[\w-]+(?:=\S+)?)*\s+)?(?:tsx|ts-node)\s+-e\b[\s\S]*(?:from\s+['"]\.\/|import\(['"]\.\/|require\(['"]\.\/|src\/)/,
		/\b(?:npx(?:\s+-[\w-]+(?:=\S+)?)*\s+)?(?:tsx|ts-node)\s+(?:[\w./-]*\/)?(?:index|main|cli|app|server|smoke)[\w.-]*\.[cm]?tsx?\b/,
		/\bnode(?:\s+--[\w=-]+)*\s+(?:[\w./-]*\/)?(?:index|main|cli|app|server|smoke)[\w.-]*\.[cm]?js\b/,
		/\bbun\s+(?:[\w./-]*\/)?(?:index|main|cli|app|server|smoke)[\w.-]*\.[cm]?[jt]sx?\b/,
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
		if (input[key] !== undefined) out[key] = redactReceiptValue(input[key]);
	}
	return out;
}

function byteLength(value: unknown): number | undefined {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined;
}

function redactReceiptValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map((item) => redactReceiptValue(item));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactReceiptValue(item)]),
	);
}
