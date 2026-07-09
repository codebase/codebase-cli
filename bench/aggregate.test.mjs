import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const resultsDir = join(__dirname, "results");
const aggregatePath = join(__dirname, "aggregate.mjs");

describe("bench aggregate", () => {
	let sweepId;
	let sweepDir;

	beforeEach(() => {
		sweepId = `aggregate-test-${process.pid}-${Date.now()}`;
		sweepDir = join(resultsDir, sweepId);
		mkdirSync(sweepDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(sweepDir, { recursive: true, force: true });
	});

	it("surfaces reproducibility provenance in markdown and json scorecards", () => {
		const fakeSecret = "ghp_0123456789abcdef0123456789abcdef0123";
		writeFileSync(
			join(sweepDir, "runs.jsonl"),
				`${JSON.stringify(makeRun({ scenario: "task-list-fidelity", run: 1, failure: `leaked ${fakeSecret}` }))}\n` +
				`${JSON.stringify(makeRun({ scenario: "memory-secret-hygiene", run: 1, writerRedactions: 2 }))}\n` +
				`${JSON.stringify(makeRun({ scenario: "memory-retrieval", run: 1 }))}\n` +
				`${JSON.stringify(makeRun({ scenario: "context-continuity", run: 1 }))}\n`,
		);
		const jsonOut = join(sweepDir, "scorecard.json");

		const markdown = execFileSync(process.execPath, [aggregatePath, sweepId, "--json-out", jsonOut], {
			cwd: join(__dirname, ".."),
			encoding: "utf8",
		});
		const scorecard = JSON.parse(readFileSync(jsonOut, "utf8"));
		const sweep = scorecard.sweeps[0];

		expect(markdown).not.toContain(fakeSecret);
		expect(markdown).toContain("leaked [REDACTED]");
		expect(JSON.stringify(scorecard)).not.toContain(fakeSecret);
		expect(markdown).toContain("CLI builds: 2.0.0-test @ /tmp/codebase x4");
		expect(markdown).toContain("Repo commits: abc123def456 x4; dirty runs 0/4");
		expect(markdown).toContain("Runner flags: reliable 4/4, isolated HOME 4/4");
		expect(markdown).toContain("Public artifact redaction: ruleset v1; writer redactions 2; report-time redactions 1");
		expect(sweep.provenance).toMatchObject({
			recordedRuns: 4,
			repoDirtyRuns: 0,
			reliableRuns: 4,
			isolatedHomeRuns: 4,
		});
		expect(sweep.provenance.cliBuilds).toEqual([{ value: "2.0.0-test @ /tmp/codebase", runs: 4 }]);
		expect(sweep.redaction).toMatchObject({
			applied: true,
			rulesVersion: 1,
			writerRedactions: 2,
			runsWithWriterRedactions: 1,
			reportTimeRedactions: 1,
			runsWithReportTimeRedactions: 1,
		});
		expect(sweep.claims.taskFidelity.taskEvidenceCount).toBe(1);
		expect(sweep.claims.memoryHygiene.passCount).toBe(1);
		expect(sweep.claims.memoryRetrieval.passCount).toBe(1);
		expect(sweep.claims.contextContinuity.passCount).toBe(1);
		expect(markdown).toContain("| Memory retrieval | 1/1 (100%) on memory-retrieval scenarios |");
		expect(markdown).toContain("| Context continuity | 1/1 (100%) on long/noisy context-continuity scenarios |");
	});

	it("does not present all-zero usage as measured free cost", () => {
		writeFileSync(
			join(sweepDir, "runs.jsonl"),
			`${JSON.stringify(makeRun({ scenario: "fix-typo", run: 1, unreportedUsage: true }))}\n`,
		);

		const markdown = execFileSync(process.execPath, [aggregatePath, sweepId], {
			cwd: join(__dirname, ".."),
			encoding: "utf8",
		});

		expect(markdown).toContain("| Cost | average passing run not reported |");
		expect(markdown).toContain("| fix-typo | 1 | 12.0s | 4.00 | not reported | not reported | not reported | not reported |");
		expect(markdown).not.toContain("$0.0000");
	});
});

function makeRun({ scenario, run, failure, writerRedactions = 0, unreportedUsage = false }) {
	return {
		scenario,
		run,
		sweepId: "aggregate-test",
		bench: {
			schemaVersion: 1,
			runner: "bench/run.mjs",
			cliPath: "/tmp/codebase",
			cliVersion: "2.0.0-test",
			reliable: true,
			isolateHome: true,
			timeoutMs: 300000,
			nodeVersion: "v20.0.0",
			repoRoot: "/tmp/codebase-cli",
			repoCommit: "abc123def456",
			repoDirty: false,
			scenario,
			run,
			startedAt: "2026-07-07T00:00:00.000Z",
			endedAt: "2026-07-07T00:00:12.000Z",
			publicArtifact: {
				secretRedaction: {
					applied: true,
					rulesVersion: 1,
					replacements: writerRedactions,
				},
			},
		},
		model: { provider: "faux", id: "test-model", name: "Test Model" },
		source: "byok",
		ok: true,
		exitCode: 0,
		elapsedMs: 12000,
		usage: unreportedUsage
			? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				}
			: { input: 100, output: 25, cacheRead: 0, cost: { total: 0.01 } },
		toolCalls: 4,
		toolNames: ["create_task", "update_task", "shell", "update_task"],
		receipt: {
			ok: true,
			summary: {
				completedTasks: 1,
				openTasks: 0,
				mutationCount: 1,
				verificationCount: 1,
				verificationAfterLastMutationCount: 1,
				completedTasksWithEvidence: 1,
				completedTasksWithVerification: 1,
				finalAnswerMentionsFreshVerification: true,
				checkpoints: 1,
			},
			failures: failure ? [failure] : [],
		},
		receiptPassed: true,
		verifyPassed: true,
		verifyExit: 0,
		ts: Date.UTC(2026, 6, 7),
	};
}
