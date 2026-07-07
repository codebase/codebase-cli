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
		out(
			`${record.id}  ${status.padEnd(4)}  tasks ${tasks.completedTasks}/${tasks.taskCount}  verified ${tasks.verificationAfterLastMutationCount}/${tasks.verificationCount}  ${record.cwd}\n`,
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
	const lines = [
		`Receipt: ${record.id}`,
		`Status: ${record.ok ? "OK" : "FAILED"} (exit ${record.exitCode})`,
		`Created: ${record.createdAt}`,
		`Project: ${record.cwd}`,
		`Model: ${record.model.name} (${record.model.provider}/${record.model.id})`,
		`Duration: ${formatMs(record.durationMs)}`,
		`Tasks: ${s.completedTasks}/${s.taskCount} completed, ${s.completedTasksWithEvidence} with evidence`,
		`Verification: ${s.verificationAfterLastMutationCount}/${s.verificationCount} fresh after final mutation, ${completedTasksWithVerification}/${s.completedTasks} completed tasks verified`,
		`Final answer: ${s.finalAnswerMentionsFreshVerification ? "named fresh verification" : "missing fresh verification"}`,
		`Mutations: ${s.mutationCount}, checkpoints: ${s.checkpoints}`,
		`File: ${path}`,
	];
	if (record.code || record.error) lines.push(`Error: ${[record.code, record.error].filter(Boolean).join(" - ")}`);
	if (record.receipt.failures.length > 0) {
		lines.push("", "Failures:");
		for (const failure of record.receipt.failures) lines.push(`- ${failure}`);
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
		`- Final answer: ${s.finalAnswerMentionsFreshVerification ? "named fresh verification" : "missing fresh verification"}`,
		`- Mutations: ${s.mutationCount}`,
		`- Checkpoints: ${s.checkpoints}`,
	];
	if (record.receipt.failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const failure of record.receipt.failures) lines.push(`- ${failure}`);
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

function completedTaskVerificationCount(record: ReceiptRecord): number {
	const summary = record.receipt.summary as { completedTasksWithVerification?: unknown };
	if (typeof summary.completedTasksWithVerification === "number") return summary.completedTasksWithVerification;
	return record.receipt.taskEvidence.filter((item) => item.status === "completed" && item.verification.length > 0)
		.length;
}

function formatMs(value: number | undefined): string {
	if (typeof value !== "number") return "n/a";
	if (value < 1000) return `${value}ms`;
	return `${(value / 1000).toFixed(1)}s`;
}
