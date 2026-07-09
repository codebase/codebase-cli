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
