import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
		const fakeSecret = "ghp_0123456789abcdef0123456789abcdef0123";

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
		expect(jsonl).not.toContain(fakeSecret);
		expect(jsonl).toContain("[REDACTED]");
		expect(run).toMatchObject({
			scenario: "fix-typo",
			run: 1,
			ok: true,
			exitCode: 0,
			verifyPassed: true,
			receiptPassed: true,
			toolCalls: 5,
		});
		expect(run.finalText).toContain("[REDACTED]");
		expect(run.receipt.verification[0].command).toContain("[REDACTED]");
		expect(run.bench.publicArtifact.secretRedaction).toMatchObject({
			applied: true,
			rulesVersion: 1,
		});
		expect(run.bench.publicArtifact.secretRedaction.replacements).toBeGreaterThanOrEqual(3);
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

	it("runs scenario setup-home hooks before invoking the CLI", () => {
		sweepId = `run-memory-test-${process.pid}-${Date.now()}`;

		const stdout = execFileSync(
			process.execPath,
			[
				runPath,
				"--scenario",
				"memory-retrieval",
				"--runs",
				"1",
				"--cli",
				fakeCliPath,
				"--sweep-id",
				sweepId,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);

		expect(stdout).toContain("✓ PASS");

		const jsonl = readFileSync(join(resultsDir, sweepId, "runs.jsonl"), "utf8").trim();
		const run = JSON.parse(jsonl);
		expect(run).toMatchObject({
			scenario: "memory-retrieval",
			run: 1,
			ok: true,
			exitCode: 0,
			verifyPassed: true,
		});
		expect(run.toolNames).not.toContain("read_memory");
		expect(run.verifyStdout).toContain("memory retrieval ok");
	});

	it("honors CODEBASE_BENCH_RESULTS_DIR for packaged CLI wrappers", () => {
		sweepId = `run-results-dir-test-${process.pid}-${Date.now()}`;
		const root = mkdtempSync(join(tmpdir(), "codebase-bench-results-dir-"));
		const externalResultsDir = join(root, "bench", "results");

		try {
			const stdout = execFileSync(
				process.execPath,
				[
					runPath,
					"--scenario",
					"fix-typo",
					"--runs",
					"1",
					"--cli",
					fakeCliPath,
					"--sweep-id",
					sweepId,
				],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: { ...process.env, CODEBASE_BENCH_RESULTS_DIR: externalResultsDir },
				},
			);

			expect(stdout).toContain(`results:   ${join(externalResultsDir, sweepId, "runs.jsonl")}`);
			const jsonl = readFileSync(join(externalResultsDir, sweepId, "runs.jsonl"), "utf8").trim();
			const run = JSON.parse(jsonl);
			expect(run).toMatchObject({ scenario: "fix-typo", ok: true, verifyPassed: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the context-continuity scenario through setup memory and verifier checks", () => {
		sweepId = `run-context-test-${process.pid}-${Date.now()}`;

		const stdout = execFileSync(
			process.execPath,
			[
				runPath,
				"--scenario",
				"context-continuity",
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

		const jsonl = readFileSync(join(resultsDir, sweepId, "runs.jsonl"), "utf8").trim();
		const run = JSON.parse(jsonl);
		expect(run).toMatchObject({
			scenario: "context-continuity",
			run: 1,
			ok: true,
			exitCode: 0,
			verifyPassed: true,
			receiptPassed: true,
		});
		expect(run.toolNames).toContain("read_memory");
		expect(run.toolNames).toContain("read_file");
		expect(run.verifyStdout).toContain("context continuity ok");
	});

	it("runs the permission-denial-recovery scenario through deny config and verifier checks", () => {
		sweepId = `run-permission-test-${process.pid}-${Date.now()}`;

		const stdout = execFileSync(
			process.execPath,
			[
				runPath,
				"--scenario",
				"permission-denial-recovery",
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

		const jsonl = readFileSync(join(resultsDir, sweepId, "runs.jsonl"), "utf8").trim();
		const run = JSON.parse(jsonl);
		expect(run).toMatchObject({
			scenario: "permission-denial-recovery",
			run: 1,
			ok: true,
			exitCode: 0,
			verifyPassed: true,
			receiptPassed: true,
		});
		expect(run.toolNames).toContain("shell");
		expect(run.toolNames).toContain("edit_file");
		expect(run.verifyStdout).toContain("permission denial recovery ok");
	});
});
