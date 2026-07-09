import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type ReceiptRecord, ReceiptStore } from "./receipt-store.js";

export interface ReceiptCliOptions {
	store?: ReceiptStore;
	cwd?: string;
	out?: (s: string) => void;
	err?: (s: string) => void;
}

interface ParsedReceiptArgs {
	command: "show" | "list";
	id: string;
	limit: number;
	format: "text" | "json" | "markdown";
	outPath?: string;
	help?: boolean;
	error?: string;
}

export async function runReceiptSubcommand(argv: string[], options: ReceiptCliOptions = {}): Promise<number> {
	const out = options.out ?? ((s) => process.stdout.write(s));
	const err = options.err ?? ((s) => process.stderr.write(s));
	const store = options.store ?? new ReceiptStore();
	const parsed = parseReceiptArgs(argv.slice(1));
	if (parsed.help) {
		printReceiptHelp(out);
		return 0;
	}
	if (parsed.error) {
		err(`${parsed.error}\n`);
		return 2;
	}

	if (parsed.command === "list") return listReceipts(store, parsed.limit, out);

	const record = store.load(parsed.id);
	if (!record) {
		err(parsed.id === "latest" ? "no reliable receipts found\n" : `receipt not found: ${parsed.id}\n`);
		return 1;
	}
	const rendered = renderReceipt(record, parsed.format, store.pathFor(record.id));
	if (parsed.outPath) {
		const target = isAbsolute(parsed.outPath)
			? parsed.outPath
			: resolve(options.cwd ?? process.cwd(), parsed.outPath);
		writeFileSync(target, rendered, "utf8");
		out(`wrote ${target}\n`);
		return 0;
	}
	out(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
	return 0;
}

function parseReceiptArgs(args: string[]): ParsedReceiptArgs {
	let command: ParsedReceiptArgs["command"] = "show";
	let id = "latest";
	let limit = 10;
	let format: ParsedReceiptArgs["format"] = "text";
	let outPath: string | undefined;
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h" || arg === "help") return { command, id, limit, format, help: true };
		if (arg === "--json") {
			format = "json";
			continue;
		}
		if (arg === "--markdown" || arg === "--md") {
			format = "markdown";
			continue;
		}
		if (arg === "--out" || arg === "-o") {
			const value = args[++i];
			if (!value) return { command, id, limit, format, error: `${arg} requires a path` };
			outPath = value;
			continue;
		}
		if (arg.startsWith("--out=")) {
			outPath = arg.slice("--out=".length);
			continue;
		}
		if (arg === "--limit") {
			const value = args[++i];
			const parsed = value ? Number.parseInt(value, 10) : NaN;
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return { command, id, limit, format, error: "--limit requires a positive integer" };
			}
			limit = parsed;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return { command, id, limit, format, error: "--limit requires a positive integer" };
			}
			limit = parsed;
			continue;
		}
		if (arg.startsWith("-")) return { command, id, limit, format, error: `unknown flag: ${arg}` };
		positionals.push(arg);
	}

	if (positionals[0] === "list" || positionals[0] === "ls") {
		command = "list";
	} else if (positionals[0] === "show" || positionals[0] === "export") {
		id = positionals[1] ?? "latest";
		if (positionals[0] === "export" && format === "text") format = "markdown";
	} else if (positionals[0]) {
		id = positionals[0];
	}

	return { command, id, limit, format, outPath };
}

function printReceiptHelp(out: (s: string) => void): void {
	out(
		[
			"usage: codebase receipt [list | show [id] | export [id]] [--json|--markdown] [--out path]",
			"",
			"Inspect reliable-mode receipts saved by `codebase auto --reliable`.",
			"Failed summaries include audit gates, failure reasons, and next actions.",
			"",
			"Commands:",
			"  receipt                 show the latest receipt summary",
			"  receipt list            list recent receipts",
			"  receipt show [id]       show one receipt (default: latest)",
			"  receipt export [id]     print markdown for one receipt",
			"",
			"Options:",
			"  --json                  print the full stored receipt record",
			"  --markdown, --md        print a shareable markdown summary",
			"  --out, -o <path>        write output to a file",
			"  --limit <n>             list limit (default: 10)",
			"",
		].join("\n"),
	);
}

function listReceipts(store: ReceiptStore, limit: number, out: (s: string) => void): number {
	const records = store.list().slice(0, limit);
	if (records.length === 0) {
		out('No reliable receipts yet. Run: codebase auto --reliable "..."\n');
		return 0;
	}
	out("recent reliable receipts:\n");
	for (const record of records) {
		const status = record.ok ? "ok" : "fail";
		const tasks = record.receipt.summary;
		const firstFailure =
			!record.ok && record.receipt.failures[0] ? `  ${truncateOneLine(record.receipt.failures[0], 84)}` : "";
		out(
			`${record.id}  ${status.padEnd(4)}  tasks ${tasks.completedTasks}/${tasks.taskCount}  verified ${tasks.verificationAfterLastMutationCount}/${tasks.verificationCount}  ${record.cwd}${firstFailure}\n`,
		);
	}
	return 0;
}

function renderReceipt(record: ReceiptRecord, format: ParsedReceiptArgs["format"], path: string): string {
	if (format === "json") return `${JSON.stringify(record, null, 2)}\n`;
	if (format === "markdown") return renderMarkdown(record, path);
	return renderText(record, path);
}

function renderText(record: ReceiptRecord, path: string): string {
	const s = record.receipt.summary;
	const completedTasksWithVerification = completedTaskVerificationCount(record);
	const finalProof = finalProofSummary(record);
	const lines = [
		`Receipt: ${record.id}`,
		`Status: ${record.ok ? "OK" : "FAILED"} (exit ${record.exitCode})`,
		`Created: ${record.createdAt}`,
		`Project: ${record.cwd}`,
		`Model: ${record.model.name} (${record.model.provider}/${record.model.id})`,
		`Duration: ${formatMs(record.durationMs)}`,
		`Tasks: ${s.completedTasks}/${s.taskCount} completed, ${s.completedTasksWithEvidence} with evidence`,
		`Verification: ${s.verificationAfterLastMutationCount}/${s.verificationCount} fresh after final mutation, ${completedTasksWithVerification}/${s.completedTasks} completed tasks verified`,
		`Final answer: ${finalProof.summary}`,
		`Mutations: ${s.mutationCount}, checkpoints: ${s.checkpoints}`,
		`File: ${path}`,
	];
	if (record.code || record.error) lines.push(`Error: ${[record.code, record.error].filter(Boolean).join(" - ")}`);
	lines.push("", "Gates:");
	for (const gate of reliabilityGates(record)) {
		lines.push(`- [${gate.ok ? "ok" : "fail"}] ${gate.label}: ${gate.detail}`);
	}
	if (record.receipt.failures.length > 0) {
		lines.push("", "Failures:");
		for (const failure of record.receipt.failures) lines.push(`- ${failure}`);
	}
	const actions = nextActions(record);
	if (actions.length > 0) {
		lines.push("", "Next actions:");
		for (const action of actions) lines.push(`- ${action}`);
	}
	if (record.receipt.warnings.length > 0) {
		lines.push("", "Warnings:");
		for (const warning of record.receipt.warnings) lines.push(`- ${warning}`);
	}
	if (record.receipt.verification.length > 0) {
		lines.push("", "Verification:");
		for (const item of record.receipt.verification) lines.push(`- ${item.command} (${formatMs(item.durationMs)})`);
	}
	if (record.receipt.taskEvidence.length > 0) {
		lines.push("", "Tasks:");
		for (const item of record.receipt.taskEvidence) {
			lines.push(
				`- ${item.id} ${item.status}: ${item.title} (${item.toolCalls.length} tools, ${item.mutations.length} mutations, ${item.verification.length} verifies)`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function renderMarkdown(record: ReceiptRecord, path: string): string {
	const s = record.receipt.summary;
	const completedTasksWithVerification = completedTaskVerificationCount(record);
	const finalProof = finalProofSummary(record);
	const lines = [
		`# Codebase Reliable Receipt`,
		"",
		`- **ID:** \`${record.id}\``,
		`- **Status:** ${record.ok ? "OK" : "FAILED"} (exit ${record.exitCode})`,
		`- **Created:** ${record.createdAt}`,
		`- **Project:** \`${record.cwd}\``,
		`- **Model:** ${record.model.name} (\`${record.model.provider}/${record.model.id}\`)`,
		`- **Duration:** ${formatMs(record.durationMs)}`,
		`- **Stored at:** \`${path}\``,
		"",
		"## Summary",
		"",
		`- Tasks: ${s.completedTasks}/${s.taskCount} completed, ${s.completedTasksWithEvidence} with evidence`,
		`- Verification: ${s.verificationAfterLastMutationCount}/${s.verificationCount} fresh after final mutation, ${completedTasksWithVerification}/${s.completedTasks} completed tasks verified`,
		`- Final answer: ${finalProof.summary}`,
		`- Mutations: ${s.mutationCount}`,
		`- Checkpoints: ${s.checkpoints}`,
	];
	lines.push("", "## Gates", "");
	for (const gate of reliabilityGates(record)) {
		lines.push(`- **${gate.label}:** ${gate.ok ? "OK" : "FAIL"} - ${gate.detail}`);
	}
	if (record.receipt.failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const failure of record.receipt.failures) lines.push(`- ${failure}`);
	}
	const actions = nextActions(record);
	if (actions.length > 0) {
		lines.push("", "## Next Actions", "");
		for (const action of actions) lines.push(`- ${action}`);
	}
	if (record.receipt.warnings.length > 0) {
		lines.push("", "## Warnings", "");
		for (const warning of record.receipt.warnings) lines.push(`- ${warning}`);
	}
	if (record.receipt.taskEvidence.length > 0) {
		lines.push("", "## Task Evidence", "");
		for (const item of record.receipt.taskEvidence) {
			lines.push(
				`- \`${item.id}\` **${item.status}**: ${item.title} - ${item.toolCalls.length} tools, ${item.mutations.length} mutations, ${item.verification.length} verifies`,
			);
		}
	}
	if (record.receipt.verification.length > 0) {
		lines.push("", "## Verification", "");
		for (const item of record.receipt.verification)
			lines.push(`- \`${item.command}\` (${formatMs(item.durationMs)})`);
	}
	return `${lines.join("\n")}\n`;
}

interface ReliabilityGate {
	label: string;
	ok: boolean;
	detail: string;
}

function reliabilityGates(record: ReceiptRecord): ReliabilityGate[] {
	const s = record.receipt.summary;
	const failures = record.receipt.failures.join("\n");
	const completedTasksWithVerification = completedTaskVerificationCount(record);
	const mutationCount = s.mutationCount ?? record.receipt.mutations.length;
	const finalProof = finalProofSummary(record);
	return [
		{
			label: "Task list",
			ok:
				s.taskCount > 0 &&
				s.completedTasks > 0 &&
				s.openTasks === 0 &&
				!matchesAny(failures, [/no task list/, /no tasks were completed/, /open tasks remain/]),
			detail: `${s.completedTasks}/${s.taskCount} completed, ${s.openTasks} open, ${s.cancelledTasks} cancelled`,
		},
		{
			label: "Task lifecycle",
			ok: !matchesAny(failures, [/skipped in_progress/, /multiple tasks were in_progress/]),
			detail: "completed tasks must pass through in_progress with only one active task",
		},
		{
			label: "Task evidence",
			ok:
				s.completedTasks > 0 &&
				s.completedTasksWithEvidence === s.completedTasks &&
				!matchesAny(failures, [/lacked evidence/]),
			detail: `${s.completedTasksWithEvidence}/${s.completedTasks} completed tasks have tool evidence`,
		},
		{
			label: "Verification",
			ok:
				mutationCount === 0 ||
				(s.verificationCount > 0 &&
					s.verificationAfterLastMutationCount > 0 &&
					completedTasksWithVerification > 0 &&
					!matchesAny(failures, [
						/no successful verification/,
						/no completed task captured verification/,
						/before the last file mutation/,
					])),
			detail:
				mutationCount === 0
					? "no file mutations; command verification not required"
					: `${s.verificationAfterLastMutationCount}/${s.verificationCount} fresh, ${completedTasksWithVerification}/${s.completedTasks} completed tasks verified`,
		},
		{
			label: "Final proof",
			ok: finalProof.ok,
			detail: finalProof.detail,
		},
	];
}

function nextActions(record: ReceiptRecord): string[] {
	const actions: string[] = [];
	for (const failure of record.receipt.failures) {
		if (failure.includes("no task list was created")) {
			actions.push("Start reliable work by creating task entries before editing or verification.");
		} else if (failure.includes("no tasks were completed") || failure.includes("open tasks remain")) {
			actions.push("Complete or cancel every non-cancelled task before the final answer.");
		} else if (failure.includes("no successful verification command was recorded")) {
			actions.push("Run a meaningful passing verification command such as tests, build, lint, or typecheck.");
		} else if (failure.includes("no completed task captured verification evidence")) {
			actions.push(
				"Run verification while the implementation task is in_progress, or create an in_progress verification task.",
			);
		} else if (failure.includes("successful verification ran before the last file mutation")) {
			actions.push("Rerun verification after the final file mutation.");
		} else if (failure.includes("final answer did not name")) {
			actions.push("End with a positive final proof sentence that names the passing command exactly.");
		} else if (failure.includes("final answer did not state no file-change verification was needed")) {
			actions.push("For read-only or memory-only runs, state that no file-change verification was needed.");
		} else if (failure.includes("lacked evidence")) {
			actions.push(
				"Keep each task in_progress while reads, edits, searches, shell commands, or checks create evidence.",
			);
		} else if (failure.includes("skipped in_progress")) {
			actions.push("Move each task to in_progress before doing or completing its work.");
		} else if (failure.includes("multiple tasks were in_progress")) {
			actions.push("Keep exactly one task in_progress at a time.");
		}
	}
	if (actions.length === 0 && !record.ok) {
		actions.push("Inspect the full JSON receipt for tool calls, task transitions, and verifier evidence.");
	}
	return [...new Set(actions)];
}

function completedTaskVerificationCount(record: ReceiptRecord): number {
	const summary = record.receipt.summary as { completedTasksWithVerification?: unknown };
	if (typeof summary.completedTasksWithVerification === "number") return summary.completedTasksWithVerification;
	return record.receipt.taskEvidence.filter((item) => item.status === "completed" && item.verification.length > 0)
		.length;
}

function finalProofSummary(record: ReceiptRecord): { ok: boolean; summary: string; detail: string } {
	const summary = record.receipt.summary as {
		mutationCount?: number;
		verificationCount?: number;
		finalAnswerMentionsFreshVerification?: unknown;
		finalAnswerMentionsNoFileChangeVerification?: unknown;
	};
	const failures = record.receipt.failures.join("\n");
	const mutationCount = summary.mutationCount ?? record.receipt.mutations.length;
	const verificationCount = summary.verificationCount ?? record.receipt.verification.length;
	const mentionsFresh =
		summary.finalAnswerMentionsFreshVerification === true ||
		record.receipt.finalAnswer?.mentionsFreshVerification === true;
	const mentionsNoFileChange =
		summary.finalAnswerMentionsNoFileChangeVerification === true ||
		record.receipt.finalAnswer?.mentionsNoFileChangeVerification === true ||
		finalTextMentionsNoFileChangeVerification(record.finalText);

	if (mutationCount > 0 || verificationCount > 0) {
		const ok = mentionsFresh && !matchesAny(failures, [/final answer did not name/]);
		return {
			ok,
			summary: ok ? "named fresh verification" : "missing fresh verification",
			detail: ok ? "final answer named fresh verification" : "final answer must positively name fresh verification",
		};
	}

	const ok =
		mentionsNoFileChange &&
		!matchesAny(failures, [/final answer did not state no file-change verification was needed/]);
	return {
		ok,
		summary: ok ? "stated no file-change verification was needed" : "missing no-change verification statement",
		detail: ok
			? "final answer explained no file-change verification was needed"
			: "final answer must state no file-change verification was needed",
	};
}

function finalTextMentionsNoFileChangeVerification(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
	return (
		/\bno\s+(?:file[- ]?change|code[- ]?change|source[- ]?change)\s+verification\s+(?:was\s+)?(?:needed|required|necessary)\b/.test(
			normalized,
		) ||
		/\b(?:file|code|source|working tree)\s+changes?\s+(?:were\s+)?(?:not\s+)?(?:made|needed|required)\b[\s\S]*\bno\s+(?:verification|test|tests|check)\s+(?:was\s+)?(?:needed|required|necessary)\b/.test(
			normalized,
		) ||
		/\bread[- ]only\b[\s\S]*\bno\s+(?:file[- ]?change\s+)?verification\s+(?:was\s+)?(?:needed|required|necessary)\b/.test(
			normalized,
		)
	);
}

function formatMs(value: number | undefined): string {
	if (typeof value !== "number") return "n/a";
	if (value < 1000) return `${value}ms`;
	return `${(value / 1000).toFixed(1)}s`;
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

function truncateOneLine(value: string, maxChars: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxChars) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
