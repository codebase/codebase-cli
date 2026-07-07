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
		expect(text).toContain("Verification: 1/1 fresh");
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
		checkpoints: [],
		failures: [],
		warnings: [],
	};
}
