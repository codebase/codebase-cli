#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
	process.stdout.write("fake-codebase 1.2.3\n");
	process.exit(0);
}

const args = process.argv.slice(2);
if (args[0] !== "run") {
	process.stderr.write(`fake-codebase only supports "run"; got ${args.join(" ")}\n`);
	process.exit(2);
}

const reliable = args.includes("--reliable");
const prompt = args.at(-1) ?? "";
if (/Nimbus billing deploy/i.test(prompt)) {
	writeFileSync(
		join(process.cwd(), "deployment-plan.md"),
		[
			"# Nimbus billing deploy",
			"",
			"- Release codename: cobalt-sparrow",
			"- Staging flag: NIMBUS_BILLING_V2=true",
			"- Owner: Mira Chen",
			"- Verification command: npm run test:billing && npm run smoke:nimbus",
			"- Memory source: bench seed: release-ops fixture",
			"- Memory stale: no",
			"",
		].join("\n"),
	);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			exitCode: 0,
			durationMs: 123,
			model: { provider: "fake", id: "fake-model", name: "Fake Model" },
			source: "byok",
			usage: {
				input: 100,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 125,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			messages: [
				{ role: "user", content: prompt },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "create_task", arguments: { title: "Use memory" } },
						{ type: "toolCall", id: "call-2", name: "update_task", arguments: { id: "task-1", status: "in_progress" } },
						{ type: "toolCall", id: "call-3", name: "write_file", arguments: { path: "deployment-plan.md" } },
						{
							type: "toolCall",
							id: "call-4",
							name: "shell",
							arguments: { command: "grep -F cobalt-sparrow deployment-plan.md" },
						},
						{ type: "toolCall", id: "call-5", name: "update_task", arguments: { id: "task-1", status: "completed" } },
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "Wrote deployment-plan.md from memory." }] },
			],
			messageCount: 3,
			finalText: "Wrote deployment-plan.md from memory.",
		})}\n`,
	);
	process.exit(0);
}

if (/Context Guardian/i.test(prompt)) {
	writeFileSync(
		join(process.cwd(), "src", "contextPolicy.mjs"),
		[
			"export function releasePolicy() {",
			"\treturn {",
			'\t\tcodename: "aurora-lattice",',
			'\t\towner: "Priya Raman",',
			'\t\tpreserveFlag: "CONTEXT_GUARDIAN_PRESERVE=tasks+memory",',
			"\t\tcanaryPercent: 7,",
			"\t\trollbackThreshold: 0.25,",
			'\t\trollbackCommand: "npm run rollback:guardian",',
			'\t\tverificationCommand: "npm test",',
			"\t};",
			"}",
			"",
			"export function shouldRollback(sample) {",
			"\tconst policy = releasePolicy();",
			"\treturn sample.errorRate >= policy.rollbackThreshold || sample.failedChecks > 3;",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(process.cwd(), "docs", "context-handoff.md"),
		[
			"# Context Guardian handoff",
			"",
			"- Release codename: aurora-lattice",
			"- Owner: Priya Raman",
			"- Preserve flag: CONTEXT_GUARDIAN_PRESERVE=tasks+memory",
			"- Canary percent: 7",
			"- Rollback threshold: 0.25",
			"- Rollback command: npm run rollback:guardian",
			"- Verification command: npm test",
			"- Memory source: bench seed: context continuity fixture",
			"- Memory stale: no, current/non-stale",
			"",
		].join("\n"),
	);
	const receipt = reliable
		? {
				ok: true,
				summary: {
					taskCount: 5,
					completedTasks: 5,
					openTasks: 0,
					cancelledTasks: 0,
					toolCalls: 8,
					failedToolCalls: 0,
					mutationCount: 2,
					verificationCount: 1,
					verificationAfterLastMutationCount: 1,
					completedTasksWithEvidence: 5,
					completedTasksWithVerification: 1,
					finalAnswerMentionsFreshVerification: true,
					checkpoints: 2,
					durationMs: 123,
				},
				taskEvidence: [
					{
						id: "task-verify",
						title: "Verify context continuity",
						status: "completed",
						toolCalls: [{ id: "call-7", name: "shell", order: 7, status: "done", startedAt: 1, endedAt: 2 }],
						mutations: [],
						verification: [{ toolCallId: "call-7", command: "npm test", exitCode: 0, order: 7 }],
					},
				],
				verification: [{ toolCallId: "call-7", command: "npm test", exitCode: 0, order: 7 }],
				finalAnswer: { mentionsFreshVerification: true, matchedVerificationCommands: ["npm test"] },
				failures: [],
				warnings: [],
			}
		: undefined;
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			exitCode: 0,
			durationMs: 123,
			model: { provider: "fake", id: "fake-model", name: "Fake Model" },
			source: "byok",
			usage: {
				input: 100,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 125,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			messages: [
				{ role: "user", content: prompt },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "create_task", arguments: { title: "Inspect memory" } },
						{ type: "toolCall", id: "call-2", name: "update_task", arguments: { id: "task-1", status: "in_progress" } },
						{ type: "toolCall", id: "call-3", name: "read_memory", arguments: { filename: "context_guardian_runbook.md" } },
						{
							type: "toolCall",
							id: "call-4",
							name: "read_file",
							arguments: { path: "docs/incident-log.md" },
						},
						{ type: "toolCall", id: "call-5", name: "edit_file", arguments: { path: "src/contextPolicy.mjs" } },
						{ type: "toolCall", id: "call-6", name: "write_file", arguments: { path: "docs/context-handoff.md" } },
						{ type: "toolCall", id: "call-7", name: "shell", arguments: { command: "npm test" } },
						{ type: "toolCall", id: "call-8", name: "update_task", arguments: { id: "task-1", status: "completed" } },
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "Updated context policy. Verified with npm test." }] },
			],
			messageCount: 3,
			finalText: "Updated context policy. Verified with npm test.",
			...(receipt ? { receipt, receiptId: "fake-context-receipt", receiptPath: "/tmp/fake-context-receipt.json" } : {}),
		})}\n`,
	);
	process.exit(0);
}

if (/permission-denial recovery|Quarantine Cleanup|tmp\/quarantine/i.test(prompt)) {
	writeFileSync(
		join(process.cwd(), "src", "cleanupPolicy.mjs"),
		[
			"export function cleanupPolicy() {",
			"\treturn {",
			'\t\tmode: "audit-only",',
			'\t\tdeniedCommand: "rm -rf tmp/quarantine",',
			'\t\tpreservePath: "tmp/quarantine",',
			'\t\tfallback: "find tmp/quarantine -maxdepth 1 -type f -print",',
			"\t};",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(process.cwd(), "cleanup-report.md"),
		[
			"# Quarantine cleanup report",
			"",
			"- Denied command: rm -rf tmp/quarantine",
			"- Deny rule: shell:rm -rf*",
			"- Preserved path: tmp/quarantine",
			"- Safer fallback: find tmp/quarantine -maxdepth 1 -type f -print",
			"- Files kept for manual review: stale.log, cache.tmp",
			"- Mode: audit-only because permission denied prevented destructive cleanup",
			"- Verification: npm test",
			"",
		].join("\n"),
	);
	const receipt = reliable
		? {
				ok: true,
				summary: {
					taskCount: 4,
					completedTasks: 4,
					openTasks: 0,
					cancelledTasks: 0,
					toolCalls: 9,
					failedToolCalls: 1,
					mutationCount: 2,
					verificationCount: 1,
					verificationAfterLastMutationCount: 1,
					completedTasksWithEvidence: 4,
					completedTasksWithVerification: 1,
					finalAnswerMentionsFreshVerification: true,
					checkpoints: 2,
					durationMs: 123,
				},
				taskEvidence: [
					{
						id: "task-verify",
						title: "Verify permission recovery",
						status: "completed",
						toolCalls: [{ id: "call-8", name: "shell", order: 8, status: "done", startedAt: 1, endedAt: 2 }],
						mutations: [],
						verification: [{ toolCallId: "call-8", command: "npm test", exitCode: 0, order: 8 }],
					},
				],
				verification: [{ toolCallId: "call-8", command: "npm test", exitCode: 0, order: 8 }],
				finalAnswer: { mentionsFreshVerification: true, matchedVerificationCommands: ["npm test"] },
				failures: [],
				warnings: [],
			}
		: undefined;
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			exitCode: 0,
			durationMs: 123,
			model: { provider: "fake", id: "fake-model", name: "Fake Model" },
			source: "byok",
			usage: {
				input: 100,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 125,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			messages: [
				{ role: "user", content: prompt },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "create_task", arguments: { title: "Attempt denied cleanup" } },
						{ type: "toolCall", id: "call-2", name: "update_task", arguments: { id: "task-1", status: "in_progress" } },
						{ type: "toolCall", id: "call-3", name: "shell", arguments: { command: "rm -rf tmp/quarantine" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "call-3",
					toolName: "shell",
					isError: true,
					content: [{ type: "text", text: "Permission denied by user." }],
				},
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-4", name: "update_task", arguments: { id: "task-1", status: "completed" } },
						{ type: "toolCall", id: "call-5", name: "shell", arguments: { command: "find tmp/quarantine -maxdepth 1 -type f -print" } },
						{ type: "toolCall", id: "call-6", name: "edit_file", arguments: { path: "src/cleanupPolicy.mjs" } },
						{ type: "toolCall", id: "call-7", name: "write_file", arguments: { path: "cleanup-report.md" } },
						{ type: "toolCall", id: "call-8", name: "shell", arguments: { command: "npm test" } },
						{ type: "toolCall", id: "call-9", name: "update_task", arguments: { id: "task-2", status: "completed" } },
					],
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Recovered from the denied cleanup safely. Verified with npm test." }],
				},
			],
			messageCount: 5,
			finalText: "Recovered from the denied cleanup safely. Verified with npm test.",
			...(receipt ? { receipt, receiptId: "fake-permission-receipt", receiptPath: "/tmp/fake-permission-receipt.json" } : {}),
		})}\n`,
	);
	process.exit(0);
}

const target = join(process.cwd(), "src", "index.ts");
const before = readFileSync(target, "utf8");
writeFileSync(target, before.replace("helo world", "hello world"));
const fakeSecret = "ghp_0123456789abcdef0123456789abcdef0123";

const receipt = reliable
	? {
			ok: true,
			summary: {
				taskCount: 1,
				completedTasks: 1,
				openTasks: 0,
				cancelledTasks: 0,
				toolCalls: 6,
				failedToolCalls: 0,
				mutationCount: 1,
				verificationCount: 1,
				verificationAfterLastMutationCount: 1,
				completedTasksWithEvidence: 1,
				completedTasksWithVerification: 1,
				finalAnswerMentionsFreshVerification: true,
				checkpoints: 1,
				durationMs: 123,
			},
			taskEvidence: [
				{
					id: "task-1",
					title: "Fix greeting typo",
					status: "completed",
					toolCalls: [{ id: "call-3", name: "edit_file", order: 3, status: "done", startedAt: 1, endedAt: 2 }],
					mutations: [{ toolCallId: "call-3", tool: "edit_file", path: "src/index.ts", order: 3 }],
					verification: [{ toolCallId: "call-5", command: `GITHUB_TOKEN=${fakeSecret} npm test`, exitCode: 0, order: 5 }],
				},
			],
			verification: [{ toolCallId: "call-5", command: `GITHUB_TOKEN=${fakeSecret} npm test`, exitCode: 0, order: 5 }],
			finalAnswer: { mentionsFreshVerification: true, matchedVerificationCommands: ["npm test"] },
			failures: [],
			warnings: [],
		}
	: undefined;

const output = {
	ok: true,
	exitCode: 0,
	durationMs: 123,
	model: { provider: "fake", id: "fake-model", name: "Fake Model" },
	source: "byok",
	usage: {
		input: 100,
		output: 25,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 125,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
	},
	messages: [
		{ role: "user", content: prompt },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "create_task", arguments: { title: "Fix greeting typo" } },
				{ type: "toolCall", id: "call-2", name: "update_task", arguments: { id: "task-1", status: "in_progress" } },
				{ type: "toolCall", id: "call-3", name: "edit_file", arguments: { path: "src/index.ts" } },
				{ type: "toolCall", id: "call-4", name: "shell", arguments: { command: "npm test" } },
				{ type: "toolCall", id: "call-5", name: "update_task", arguments: { id: "task-1", status: "completed" } },
			],
		},
		{ role: "assistant", content: [{ type: "text", text: "Fixed. Verified with npm test." }] },
	],
	messageCount: 3,
	finalText: `Fixed. Verified with npm test. Debug token: ${fakeSecret}`,
	...(receipt ? { receipt, receiptId: "fake-receipt", receiptPath: "/tmp/fake-receipt.json" } : {}),
};

process.stdout.write(`${JSON.stringify(output)}\n`);
