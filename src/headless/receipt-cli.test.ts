import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReceiptSubcommand } from "./receipt-cli.js";
import { ReceiptStore } from "./receipt-store.js";
import type { ReliabilityReceipt } from "./reliable.js";

describe("runReceiptSubcommand", () => {
	let root: string;
	let store: ReceiptStore;
	let out: string[];
	let err: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "receipt-cli-"));
		store = new ReceiptStore({ dataRoot: root });
		out = [];
		err = [];
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function run(argv: string[]) {
		return runReceiptSubcommand(argv, {
			store,
			cwd: root,
			out: (s) => out.push(s),
			err: (s) => err.push(s),
		});
	}

	it("shows the empty state", async () => {
		expect(await run(["receipt"])).toBe(1);
		expect(err.join("")).toMatch(/no reliable receipts/i);
	});

	it("lists and shows saved receipts", async () => {
		const record = store.save(makeInput());
		expect(await run(["receipt", "list"])).toBe(0);
		expect(out.join("")).toContain(record.id);

		out.length = 0;
		expect(await run(["receipt", "show", record.id])).toBe(0);
		const text = out.join("");
		expect(text).toContain(`Receipt: ${record.id}`);
		expect(text).toContain("Tasks: 1/1 completed, 1 with evidence");
		expect(text).toContain("Verification: 1/1 fresh after final mutation, 1/1 completed tasks verified");
		expect(text).toContain("Final answer: named fresh verification");
		expect(text).toContain("Gates:");
		expect(text).toContain("- [ok] Verification:");
	});

	it("shows failed receipt gates and next actions", async () => {
		const record = store.save(makeFailedInput());

		expect(await run(["receipt", "list"])).toBe(0);
		const listText = out.join("");
		expect(listText).toContain(record.id);
		expect(listText).toContain("fail");
		expect(listText).toContain("no completed task captured verification evidence");

		out.length = 0;
		expect(await run(["receipt", "show", record.id])).toBe(0);
		const text = out.join("");
		expect(text).toContain("Status: FAILED");
		expect(text).toContain("Gates:");
		expect(text).toContain("- [fail] Verification:");
		expect(text).toContain("- [fail] Final proof:");
		expect(text).toContain("Next actions:");
		expect(text).toContain("Run verification while the implementation task is in_progress");
		expect(text).toContain("End with a positive final proof sentence");

		out.length = 0;
		expect(await run(["receipt", "export", record.id])).toBe(0);
		const markdown = out.join("");
		expect(markdown).toContain("## Gates");
		expect(markdown).toContain("**Verification:** FAIL");
		expect(markdown).toContain("## Next Actions");
	});

	it("shows read-only final proof without requiring command verification", async () => {
		const record = store.save(makeReadOnlyInput());

		expect(await run(["receipt", "show", record.id])).toBe(0);
		const text = out.join("");
		expect(text).toContain("Status: OK");
		expect(text).toContain("Final answer: stated no file-change verification was needed");
		expect(text).toContain("- [ok] Verification: no file mutations; command verification not required");
		expect(text).toContain("- [ok] Final proof: final answer explained no file-change verification was needed");
	});

	it("prints full json", async () => {
		const record = store.save(makeInput());
		expect(await run(["receipt", "--json", record.id])).toBe(0);
		const parsed = JSON.parse(out.join("")) as { id: string; receipt: { ok: boolean } };
		expect(parsed.id).toBe(record.id);
		expect(parsed.receipt.ok).toBe(true);
	});

	it("exports markdown to a file", async () => {
		const record = store.save(makeInput());
		expect(await run(["receipt", "export", record.id, "--out", "receipt.md"])).toBe(0);
		const path = join(root, "receipt.md");
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("# Codebase Reliable Receipt");
		expect(out.join("")).toContain(path);
	});
});

function makeInput(): Parameters<ReceiptStore["save"]>[0] {
	return {
		cwd: "/tmp/project",
		prompt: "fix it",
		ok: true,
		exitCode: 0,
		durationMs: 1234,
		model: { provider: "faux", id: "m", name: "Model" },
		source: "byok",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		finalText: "done",
		receipt: makeReceipt(),
	};
}

function makeFailedInput(): Parameters<ReceiptStore["save"]>[0] {
	const receipt = makeReceipt();
	return {
		...makeInput(),
		ok: false,
		exitCode: 1,
		code: "reliable_gate_failed",
		error: "Reliable mode failed: no completed task captured verification evidence; final answer did not name a fresh passing verification command: npm test.",
		receipt: {
			...receipt,
			ok: false,
			summary: {
				...receipt.summary,
				completedTasksWithVerification: 0,
				finalAnswerMentionsFreshVerification: false,
				finalAnswerMentionsNoFileChangeVerification: false,
			},
			taskEvidence: [
				{
					id: "task-1",
					title: "Fix it",
					status: "completed",
					toolCalls: [{ id: "call-2", name: "write_file", args: {}, status: "done", order: 2, startedAt: 1 }],
					mutations: [],
					verification: [],
				},
			],
			finalAnswer: {
				mentionsFreshVerification: false,
				mentionsNoFileChangeVerification: false,
				matchedVerificationCommands: [],
			},
			failures: [
				"no completed task captured verification evidence",
				"final answer did not name a fresh passing verification command: npm test",
			],
		},
	};
}

function makeReadOnlyInput(): Parameters<ReceiptStore["save"]>[0] {
	return {
		...makeInput(),
		finalText: "Read README.md. No file-change verification was needed.",
		receipt: {
			...makeReceipt(),
			summary: {
				...makeReceipt().summary,
				mutationCount: 0,
				verificationCount: 0,
				verificationAfterLastMutationCount: 0,
				completedTasksWithVerification: 0,
				finalAnswerMentionsFreshVerification: false,
				finalAnswerMentionsNoFileChangeVerification: true,
				checkpoints: 0,
			},
			mutations: [],
			verification: [],
			finalAnswer: {
				mentionsFreshVerification: false,
				mentionsNoFileChangeVerification: true,
				matchedVerificationCommands: [],
			},
		},
	};
}

function makeReceipt(): ReliabilityReceipt {
	return {
		mode: "reliable",
		ok: true,
		summary: {
			taskCount: 1,
			completedTasks: 1,
			openTasks: 0,
			cancelledTasks: 0,
			toolCalls: 2,
			failedToolCalls: 0,
			mutationCount: 1,
			verificationCount: 1,
			verificationAfterLastMutationCount: 1,
			completedTasksWithEvidence: 1,
			completedTasksWithVerification: 1,
			finalAnswerMentionsFreshVerification: true,
			finalAnswerMentionsNoFileChangeVerification: false,
			checkpoints: 1,
			durationMs: 1234,
		},
		tasks: [],
		taskLifecycle: [],
		taskEvidence: [
			{
				id: "task-1",
				title: "Fix it",
				status: "completed",
				toolCalls: [],
				mutations: [],
				verification: [],
			},
		],
		tools: [],
		mutations: [],
		verification: [{ toolCallId: "call-1", command: "npm test", exitCode: 0, order: 1, startedAt: 1, endedAt: 2 }],
		finalAnswer: {
			mentionsFreshVerification: true,
			mentionsNoFileChangeVerification: false,
			matchedVerificationCommands: ["npm test"],
		},
		checkpoints: [],
		failures: [],
		warnings: [],
	};
}
