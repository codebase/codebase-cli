import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");
const runPath = join(__dirname, "run.mjs");
const fakeCliPath = join(__dirname, "_self-test", "fake-codebase-cli.mjs");
const resultsDir = join(__dirname, "results");

describe("bench run", () => {
	let sweepId;

	afterEach(() => {
		if (sweepId) rmSync(join(resultsDir, sweepId), { recursive: true, force: true });
	});

	it("runs a scenario through a fake CLI, verify.sh, JSONL receipts, and provenance", () => {
		sweepId = `run-test-${process.pid}-${Date.now()}`;

		const stdout = execFileSync(
			process.execPath,
			[
				runPath,
				"--scenario",
				"fix-typo",
				"--runs",
				"1",
				"--reliable",
				"true",
				"--cli",
				fakeCliPath,
				"--sweep-id",
				sweepId,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);

		expect(stdout).toContain("✓ PASS");
		expect(stdout).toContain("receipt=ok");
		expect(stdout).toContain("cli ver:   fake-codebase 1.2.3");

		const jsonl = readFileSync(join(resultsDir, sweepId, "runs.jsonl"), "utf8").trim();
		const run = JSON.parse(jsonl);
		expect(run).toMatchObject({
			scenario: "fix-typo",
			run: 1,
			ok: true,
			exitCode: 0,
			verifyPassed: true,
			receiptPassed: true,
			toolCalls: 5,
		});
		expect(run.toolNames).toEqual(["create_task", "update_task", "edit_file", "shell", "update_task"]);
		expect(run.receipt.summary).toMatchObject({
			completedTasks: 1,
			completedTasksWithEvidence: 1,
			completedTasksWithVerification: 1,
			verificationAfterLastMutationCount: 1,
		});
		expect(run.bench).toMatchObject({
			cliPath: fakeCliPath,
			cliVersion: "fake-codebase 1.2.3",
			reliable: true,
			isolateHome: true,
			scenario: "fix-typo",
			run: 1,
		});
		expect(typeof run.bench.repoCommit === "string" || run.bench.repoCommit === null).toBe(true);
		expect(run.verifyStdout).toContain("ok");
	});
});
