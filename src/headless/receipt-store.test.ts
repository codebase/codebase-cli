import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReceiptStore } from "./receipt-store.js";
import type { ReliabilityReceipt } from "./reliable.js";

describe("ReceiptStore", () => {
	let root: string;
	let store: ReceiptStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "receipt-store-"));
		store = new ReceiptStore({ dataRoot: root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("saves receipts with private file mode and lists newest first", () => {
		const older = store.save(makeInput({ prompt: "first" }));
		const newer = store.save(makeInput({ prompt: "second" }));

		expect(store.mode(older.id)).toBe(0o600);
		expect(store.load(older.id)?.prompt).toBe("first");
		expect(store.load("latest")?.id).toBe(newer.id);
		expect(store.list().map((item) => item.id)).toEqual([newer.id, older.id]);
	});

	it("redacts obvious secrets from durable receipt records", () => {
		const secret = "ghp_0123456789abcdef0123456789abcdef0123";
		const record = store.save(
			makeInput({
				prompt: `fix this with ${secret}`,
				error: `failed with ${secret}`,
				finalText: `done, do not leak ${secret}`,
				receipt: {
					...makeReceipt(),
					tools: [
						{
							id: "call-1",
							name: "shell",
							args: { command: `GITHUB_TOKEN=${secret} npm test` },
							status: "done",
							order: 1,
							startedAt: 1,
							endedAt: 2,
							details: { command: `GITHUB_TOKEN=${secret} npm test`, exitCode: 0 },
						},
					],
				},
			}),
		);
		const raw = readFileSync(store.pathFor(record.id), "utf8");
		const saved = store.load(record.id);

		expect(raw).not.toContain(secret);
		expect(raw).toContain("[REDACTED]");
		expect(saved?.prompt).toContain("[REDACTED]");
		expect(saved?.error).toContain("[REDACTED]");
		expect(saved?.finalText).toContain("[REDACTED]");
		expect(saved?.receipt.tools[0]?.args.command).toContain("[REDACTED]");
	});
});

function makeInput(overrides: Partial<Parameters<ReceiptStore["save"]>[0]> = {}): Parameters<ReceiptStore["save"]>[0] {
	return {
		cwd: "/tmp/project",
		prompt: "do work",
		ok: true,
		exitCode: 0,
		durationMs: 123,
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
		...overrides,
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
			durationMs: 123,
		},
		tasks: [],
		taskLifecycle: [],
		taskEvidence: [],
		tools: [],
		mutations: [],
		verification: [],
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
