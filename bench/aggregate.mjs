#!/usr/bin/env node
/**
 * Aggregate one or more bench sweep result files into a markdown
 * report. Mirrors the per-scenario means tables we already have for
 * the web bench in `polyvibe-poc/docs/benchmarks/`.
 *
 * Usage:
 *   # Single sweep
 *   node bench/aggregate.mjs sweep-2026-05-09T01-23-45
 *
 *   # Multiple sweeps to compare arms (control / treatment)
 *   node bench/aggregate.mjs sweep-control sweep-treatment
 *
 *   # Write to a file
 *   node bench/aggregate.mjs sweep-foo --out docs/benchmarks/2026-05-09-foo.md
 *
 *   # Also write machine-readable launch metrics
 *   node bench/aggregate.mjs sweep-foo --out docs/benchmarks/foo.md --json-out docs/benchmarks/foo.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, "results");
const CAPABILITY_DIMENSIONS = [
	{
		label: "core edits",
		scenarios: new Set(["add-test", "fix-typo", "multi-file-rename", "read-only-explain"]),
	},
	{
		label: "task fidelity",
		scenarios: new Set(["task-list-fidelity", "durable-task-dependencies", "complex-issue-recovery"]),
	},
	{
		label: "memory hygiene",
		scenarios: new Set(["memory-secret-hygiene"]),
	},
	{
		label: "complex recovery",
		scenarios: new Set(["complex-issue-recovery"]),
	},
];

const args = parseArgs(process.argv.slice(2));
const positional = args._;
const outPath = args.out ? resolve(args.out) : null;
const jsonOutPath = args["json-out"] ? resolve(args["json-out"]) : null;

if (positional.length === 0) {
	console.error("usage: aggregate.mjs <sweep-id> [<sweep-id> …] [--out path.md] [--json-out path.json]");
	process.exit(1);
}

const sweeps = positional.map((id) => loadSweep(id));
const generatedAt = new Date().toISOString();
const scorecard = buildScorecardJson(sweeps, generatedAt);
const md = renderReport(sweeps, scorecard);

if (outPath) {
	writeReportFile(outPath, md);
	console.error(`wrote ${outPath}`);
} else {
	process.stdout.write(md);
}
if (jsonOutPath) {
	writeReportFile(jsonOutPath, `${JSON.stringify(scorecard, null, 2)}\n`);
	console.error(`wrote ${jsonOutPath}`);
}

// ─── load ─────────────────────────────────────────────────────────────

function loadSweep(id) {
	const path = join(RESULTS_DIR, id, "runs.jsonl");
	if (!existsSync(path)) {
		console.error(`no runs.jsonl at ${path}`);
		process.exit(1);
	}
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0);
	const runs = lines.map((line) => JSON.parse(line));
	return { id, runs };
}

function writeReportFile(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function buildScorecardJson(sweeps, generatedAt) {
	return {
		schemaVersion: 1,
		generatedAt,
		sweeps: sweeps.map((sweep) => {
			const publicScorecard = publicScorecardRows(sweep.runs);
			const byScope = new Map(publicScorecard.map((row) => [row.scope, row]));
			const scenarios = [...new Set(sweep.runs.map((run) => run.scenario))].sort();
			return {
				id: sweep.id,
				runCount: sweep.runs.length,
				scenarioCount: scenarios.length,
				scenarios,
				models: summarizeModels(sweep.runs),
				provenance: summarizeProvenance(sweep.runs),
				reliableReceiptRuns: sweep.runs.filter((run) => run.receipt).length,
				publicScorecard,
				claims: {
					overall: byScope.get("overall"),
					taskFidelity: byScope.get("task fidelity") ?? null,
					memoryHygiene: byScope.get("memory hygiene") ?? null,
				},
			};
		}),
	};
}

// ─── render ───────────────────────────────────────────────────────────

function renderReport(sweeps, scorecard) {
	const lines = [];
	const date = scorecard.generatedAt.slice(0, 10);
	const title = sweeps.length === 1 ? `Bench report — ${sweeps[0].id}` : `Bench comparison — ${sweeps.map((s) => s.id).join(" vs ")}`;

	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Generated ${date} from \`bench/results/<sweep>/runs.jsonl\`.`);
	lines.push("");

	for (const sweep of sweeps) {
		const sweepScorecard = scorecard.sweeps.find((item) => item.id === sweep.id);
		lines.push(`## ${sweep.id}`);
		lines.push("");
		if (sweepScorecard) {
			lines.push(...renderMethodology(sweepScorecard));
			lines.push("");
			lines.push(...renderLaunchClaims(sweepScorecard));
			lines.push("");
		}
		lines.push(...renderPublicScorecard(sweepScorecard?.publicScorecard ?? publicScorecardRows(sweep.runs)));
		lines.push("");
		lines.push(...renderOutcomesTable(sweep.runs));
		lines.push("");
		lines.push(...renderReceiptScorecard(sweep.runs));
		lines.push("");
		lines.push(...renderPerScenarioTable(sweep.runs));
		lines.push("");
		lines.push(...renderToolUsage(sweep.runs));
		lines.push("");
	}

	if (sweeps.length >= 2) {
		lines.push(...renderComparison(sweeps));
		lines.push("");
	}

	return lines.join("\n");
}

function renderMethodology(scorecard) {
	const lines = [
		"### Methodology",
		"",
	];
	const items = [
		`- Source: \`bench/results/${scorecard.id}/runs.jsonl\``,
		`- Runs: ${scorecard.runCount} across ${scorecard.scenarioCount} scenario${scorecard.scenarioCount === 1 ? "" : "s"}`,
		`- Scenarios: ${scorecard.scenarios.join(", ") || "none"}`,
		`- Models: ${scorecard.models.map((model) => `${model.name} (${model.provider}/${model.id}) x${model.runs}`).join(", ") || "unknown"}`,
		`- Reliable receipts: ${scorecard.reliableReceiptRuns}/${scorecard.runCount} runs`,
	];
	if (scorecard.provenance?.recordedRuns > 0) {
		const p = scorecard.provenance;
		items.push(
			`- CLI builds: ${formatCountedValues(p.cliBuilds)}`,
			`- Repo commits: ${formatCountedValues(p.repoCommits)}; dirty runs ${p.repoDirtyRuns}/${p.recordedRuns}`,
			`- Runner flags: reliable ${p.reliableRuns}/${p.recordedRuns}, isolated HOME ${p.isolatedHomeRuns}/${p.recordedRuns}`,
			`- Node versions: ${formatCountedValues(p.nodeVersions)}`,
		);
	} else {
		items.push("- Run provenance: not recorded in this sweep (older harness output)");
	}
	lines.push(items.join("\n"));
	return lines;
}

function renderLaunchClaims(scorecard) {
	const claim = scorecard.claims;
	const task = claim.taskFidelity;
	const memory = claim.memoryHygiene;
	return [
		"### Claim-ready summary",
		"",
		"| claim | evidence |",
		"|---|---|",
		`| Overall pass rate | ${formatRatio(claim.overall.passCount, claim.overall.runs)} across ${claim.overall.runs} runs |`,
		`| Task fidelity | ${task ? `${formatRatio(task.passCount, task.runs)} on task-fidelity scenarios; task evidence ${formatReceiptCount(task, "taskEvidenceCount")}; task verification ${formatReceiptCount(task, "taskVerifiedCount")}` : "not in sweep"} |`,
		`| Memory hygiene | ${memory ? `${formatRatio(memory.passCount, memory.runs)} on memory hygiene scenarios` : "not in sweep"} |`,
		`| Speed | p50 passing run ${formatSeconds(claim.overall.medianPassSeconds)} |`,
		`| Cost | average passing run ${formatCost(claim.overall.avgPassCost)} |`,
		`| Receipt proof | receipt ok ${formatReceiptCount(claim.overall, "receiptOkCount")}; final proof ${formatReceiptCount(claim.overall, "finalProofCount")}; fresh verification ${formatReceiptCount(claim.overall, "freshVerifiedCount")} |`,
	];
}

function renderPublicScorecard(rows) {
	const out = [
		"### Public scorecard",
		"",
		"Launch-facing summary across all runs. Receipt columns show `not collected` unless the sweep used `--reliable true`.",
		"",
		"| scope | runs | pass rate | receipt ok | task evidence | task verified | final proof | fresh verified | p50 pass time | avg pass cost |",
		"|---|---|---|---|---|---|---|---|---|---|",
	];

	for (const row of rows) out.push(renderPublicScorecardRow(row));

	return out;
}

function publicScorecardRows(runs) {
	const rows = [publicScorecardRow("overall", runs)];
	for (const dimension of CAPABILITY_DIMENSIONS) {
		const items = runs.filter((run) => dimension.scenarios.has(run.scenario));
		if (items.length === 0) continue;
		rows.push(publicScorecardRow(dimension.label, items));
	}
	return rows;
}

function publicScorecardRow(label, runs) {
	const passing = runs.filter(isPassingRun);
	const medianElapsed = median(passing.map((run) => run.elapsedMs / 1000));
	const passCosts = passing
		.map((run) => run.usage?.cost?.total)
		.filter((value) => Number.isFinite(value));
	const avgCost = passCosts.length > 0 ? mean(passCosts) : null;
	const receipts = runs.map((run) => run.receipt).filter(Boolean);
	return {
		scope: label,
		runs: runs.length,
		passCount: passing.length,
		passRate: ratio(passing.length, runs.length),
		receiptRuns: receipts.length,
		receiptOkCount: receipts.filter((receipt) => receipt.ok === true).length,
		taskEvidenceCount: receipts.filter((receipt) => hasCompletedTaskEvidence(receipt)).length,
		taskVerifiedCount: receipts.filter((receipt) => hasCompletedTaskVerification(receipt)).length,
		finalProofCount: receipts.filter((receipt) => hasFinalAnswerProof(receipt)).length,
		freshVerifiedCount: receipts.filter((receipt) => hasFreshVerification(receipt)).length,
		medianPassSeconds: medianElapsed,
		avgPassCost: avgCost,
	};
}

function summarizeProvenance(runs) {
	const benches = runs.map((run) => run.bench).filter(Boolean);
	const recordedRuns = benches.length;
	return {
		recordedRuns,
		cliBuilds: countedValues(
			benches.map((bench) => {
				const version = bench.cliVersion ?? "unknown";
				const path = bench.cliPath ?? "unknown path";
				return `${version} @ ${path}`;
			}),
		),
		repoCommits: countedValues(
			benches.map((bench) => {
				const commit = bench.repoCommit ?? "unknown";
				return bench.repoDirty === true ? `${commit} (dirty)` : commit;
			}),
		),
		repoDirtyRuns: benches.filter((bench) => bench.repoDirty === true).length,
		reliableRuns: benches.filter((bench) => bench.reliable === true).length,
		isolatedHomeRuns: benches.filter((bench) => bench.isolateHome === true).length,
		nodeVersions: countedValues(benches.map((bench) => bench.nodeVersion ?? "unknown")),
		timeoutsMs: countedValues(benches.map((bench) => bench.timeoutMs ?? "unknown")),
	};
}

function renderPublicScorecardRow(row) {
	return [
		row.scope,
		row.runs,
		formatRatio(row.passCount, row.runs),
		formatReceiptCount(row, "receiptOkCount"),
		formatReceiptCount(row, "taskEvidenceCount"),
		formatReceiptCount(row, "taskVerifiedCount"),
		formatReceiptCount(row, "finalProofCount"),
		formatReceiptCount(row, "freshVerifiedCount"),
		formatSeconds(row.medianPassSeconds),
		formatCost(row.avgPassCost),
	]
		.map((value) => escapePipes(value))
		.join(" | ")
		.replace(/^/, "| ")
		.replace(/$/, " |");
}

function renderOutcomesTable(runs) {
	const grouped = groupBy(runs, (r) => r.scenario);
	const out = ["### Outcomes", "", "| scenario | n | passed | failed | harness-errored |", "|---|---|---|---|---|"];
	for (const [scenario, items] of grouped) {
		const passed = items.filter((r) => isPassingRun(r)).length;
		const failed = items.filter((r) => !r.harnessError && (!r.ok || !r.verifyPassed)).length;
		const errored = items.filter((r) => r.harnessError).length;
		out.push(`| ${scenario} | ${items.length} | ${passed} | ${failed} | ${errored} |`);
	}
	return out;
}

function renderReceiptScorecard(runs) {
	const withReceipt = runs.filter((r) => r.receipt);
	if (withReceipt.length === 0) {
		return [
			"### Reliability receipts",
			"",
			"No reliable-mode receipts in this sweep. Run `node bench/run.mjs --scenario all --reliable true` to collect them.",
		];
	}
	const grouped = groupBy(runs, (r) => r.scenario);
	const out = [
		"### Reliability receipts",
		"",
		"| scenario | n | receipt ok | task ok | task evidence | task verified | final proof | verified | fresh verified | avg mutations | avg verifies | avg checkpoints | common failures |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const [scenario, items] of grouped) {
		const receipts = items.map((r) => r.receipt).filter(Boolean);
		if (receipts.length === 0) {
			out.push(`| ${scenario} | ${items.length} | — | — | — | — | — | — | — | — | — | — | — |`);
			continue;
		}
		const receiptOk = receipts.filter((r) => r.ok).length;
		const taskOk = receipts.filter((r) => (r.summary?.completedTasks ?? 0) > 0 && (r.summary?.openTasks ?? 0) === 0).length;
		const taskEvidence = receipts.filter((r) => hasCompletedTaskEvidence(r)).length;
		const taskVerified = receipts.filter((r) => hasCompletedTaskVerification(r)).length;
		const finalProof = receipts.filter((r) => hasFinalAnswerProof(r)).length;
		const verified = receipts.filter((r) => (r.summary?.verificationCount ?? 0) > 0).length;
		const freshVerified = receipts.filter((r) => hasFreshVerification(r)).length;
		const avgMutations = mean(receipts.map((r) => r.summary?.mutationCount ?? r.mutations?.length ?? 0));
		const avgVerifies = mean(receipts.map((r) => r.summary?.verificationCount ?? 0));
		const avgCheckpoints = mean(receipts.map((r) => r.summary?.checkpoints ?? 0));
		out.push(
			`| ${scenario} | ${receipts.length}/${items.length} | ${receiptOk} | ${taskOk} | ${taskEvidence} | ${taskVerified} | ${finalProof} | ${verified} | ${freshVerified} | ${avgMutations.toFixed(2)} | ${avgVerifies.toFixed(2)} | ${avgCheckpoints.toFixed(2)} | ${commonFailures(receipts)} |`,
		);
	}
	return out;
}

function hasCompletedTaskEvidence(receipt) {
	const completed = receipt.summary?.completedTasks ?? 0;
	if (completed === 0) return false;
	const evidenced = receipt.summary?.completedTasksWithEvidence;
	if (typeof evidenced === "number") return evidenced >= completed;
	const byTask = receipt.taskEvidence;
	if (!Array.isArray(byTask)) return false;
	return byTask.filter((item) => item.status === "completed" && taskEvidenceCount(item) > 0).length >= completed;
}

function hasCompletedTaskVerification(receipt) {
	const completed = receipt.summary?.completedTasks ?? 0;
	if (completed === 0) return false;
	const verified = receipt.summary?.completedTasksWithVerification;
	if (typeof verified === "number") return verified >= completed;
	const byTask = receipt.taskEvidence;
	if (!Array.isArray(byTask)) return false;
	return byTask.filter((item) => item.status === "completed" && (item.verification?.length ?? 0) > 0).length >= completed;
}

function taskEvidenceCount(item) {
	return (item.toolCalls?.length ?? 0) + (item.mutations?.length ?? 0) + (item.verification?.length ?? 0);
}

function hasFinalAnswerProof(receipt) {
	if (receipt.summary?.finalAnswerMentionsFreshVerification === true) return true;
	return receipt.finalAnswer?.mentionsFreshVerification === true;
}

function hasFreshVerification(receipt) {
	const verificationCount = receipt.summary?.verificationCount ?? 0;
	const mutationCount = receipt.summary?.mutationCount ?? receipt.mutations?.length ?? 0;
	if (verificationCount === 0) return false;
	if (mutationCount === 0) return true;
	return (receipt.summary?.verificationAfterLastMutationCount ?? 0) > 0;
}

function renderPerScenarioTable(runs) {
	const grouped = groupBy(runs, (r) => r.scenario);
	const out = [
		"### Per-scenario means (passing runs only)",
		"",
		"| scenario | n_pass | elapsed | tools | input | output | cached | $/run |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (const [scenario, items] of grouped) {
		const passing = items.filter((r) => isPassingRun(r));
		if (passing.length === 0) {
			out.push(`| ${scenario} | 0 | — | — | — | — | — | — |`);
			continue;
		}
		const elapsed = mean(passing.map((r) => r.elapsedMs / 1000));
		const tools = mean(passing.map((r) => r.toolCalls ?? 0));
		const input = mean(passing.map((r) => r.usage?.input ?? 0));
		const output = mean(passing.map((r) => r.usage?.output ?? 0));
		const cached = mean(passing.map((r) => r.usage?.cacheRead ?? 0));
		const cost = mean(passing.map((r) => r.usage?.cost?.total ?? 0));
		out.push(
			`| ${scenario} | ${passing.length} | ${elapsed.toFixed(1)}s | ${tools.toFixed(2)} | ${fmt(input)} | ${fmt(output)} | ${fmt(cached)} | $${cost.toFixed(4)} |`,
		);
	}
	return out;
}

function commonFailures(receipts) {
	const counts = new Map();
	for (const receipt of receipts) {
		for (const failure of receipt.failures ?? []) {
			counts.set(failure, (counts.get(failure) ?? 0) + 1);
		}
	}
	if (counts.size === 0) return "—";
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([failure, count]) => `${escapePipes(failure)} (${count})`)
		.join("<br>");
}

function renderToolUsage(runs) {
	const counts = new Map();
	for (const r of runs) {
		if (!r.toolNames) continue;
		for (const name of r.toolNames) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	if (counts.size === 0) return [];
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const out = ["### Tool usage frequency", "", "| tool | calls |", "|---|---|"];
	for (const [name, n] of sorted) out.push(`| ${name} | ${n} |`);
	return out;
}

function renderComparison(sweeps) {
	if (sweeps.length !== 2) return [];
	const [a, b] = sweeps;
	const aGrouped = groupBy(a.runs, (r) => r.scenario);
	const bGrouped = groupBy(b.runs, (r) => r.scenario);
	const out = [
		`## A (${a.id}) vs B (${b.id})`,
		"",
		"| scenario | A elapsed | B elapsed | Δ | A tools | B tools | Δ | A $/run | B $/run | Δ |",
		"|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const scenario of aGrouped.keys()) {
		const aPass = (aGrouped.get(scenario) ?? []).filter((r) => isPassingRun(r));
		const bPass = (bGrouped.get(scenario) ?? []).filter((r) => isPassingRun(r));
		if (aPass.length === 0 || bPass.length === 0) {
			out.push(`| ${scenario} | — | — | — | — | — | — | — | — | — |`);
			continue;
		}
		const aE = mean(aPass.map((r) => r.elapsedMs / 1000));
		const bE = mean(bPass.map((r) => r.elapsedMs / 1000));
		const aT = mean(aPass.map((r) => r.toolCalls ?? 0));
		const bT = mean(bPass.map((r) => r.toolCalls ?? 0));
		const aC = mean(aPass.map((r) => r.usage?.cost?.total ?? 0));
		const bC = mean(bPass.map((r) => r.usage?.cost?.total ?? 0));
		out.push(
			`| ${scenario} | ${aE.toFixed(1)}s | ${bE.toFixed(1)}s | ${pctDelta(aE, bE)} | ${aT.toFixed(2)} | ${bT.toFixed(2)} | ${pctDelta(aT, bT)} | $${aC.toFixed(4)} | $${bC.toFixed(4)} | ${pctDelta(aC, bC)} |`,
		);
	}
	return out;
}

// ─── utils ────────────────────────────────────────────────────────────

function groupBy(items, keyFn) {
	const map = new Map();
	for (const item of items) {
		const key = keyFn(item);
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(item);
	}
	return map;
}

function mean(arr) {
	if (arr.length === 0) return 0;
	return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
	const values = arr.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (values.length === 0) return null;
	const middle = Math.floor(values.length / 2);
	if (values.length % 2 === 1) return values[middle];
	return (values[middle - 1] + values[middle]) / 2;
}

function isPassingRun(run) {
	return run.ok === true && run.verifyPassed === true && !run.harnessError;
}

function summarizeModels(runs) {
	const counts = new Map();
	for (const run of runs) {
		const model = run.model ?? {};
		const provider = model.provider ?? "?";
		const id = model.id ?? "?";
		const name = model.name ?? id;
		const key = `${provider}\0${id}\0${name}`;
		const existing = counts.get(key) ?? { provider, id, name, runs: 0 };
		existing.runs += 1;
		counts.set(key, existing);
	}
	return [...counts.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

function countedValues(values) {
	const counts = new Map();
	for (const value of values) {
		const key = String(value ?? "unknown");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([value, runs]) => ({ value, runs }))
		.sort((a, b) => b.runs - a.runs || a.value.localeCompare(b.value));
}

function formatCountedValues(values) {
	if (!Array.isArray(values) || values.length === 0) return "unknown";
	return values.map((item) => `${item.value} x${item.runs}`).join(", ");
}

function ratio(count, total) {
	if (total === 0) return null;
	return count / total;
}

function formatRatio(count, total) {
	if (total === 0) return "—";
	return `${count}/${total} (${Math.round((count / total) * 100)}%)`;
}

function formatReceiptCount(row, field) {
	if (row.receiptRuns === 0) return "not collected";
	const formatted = formatRatio(row[field] ?? 0, row.receiptRuns);
	if (row.receiptRuns === row.runs) return formatted;
	return `${formatted}; ${row.receiptRuns}/${row.runs} collected`;
}

function formatSeconds(value) {
	return value == null ? "—" : `${value.toFixed(1)}s`;
}

function formatCost(value) {
	return value == null ? "—" : `$${value.toFixed(4)}`;
}

function fmt(n) {
	if (!Number.isFinite(n)) return "—";
	return Math.round(n).toLocaleString();
}

function escapePipes(value) {
	return String(value).replaceAll("|", "\\|");
}

function pctDelta(a, b) {
	if (a === 0) return "—";
	const d = ((b - a) / a) * 100;
	const sign = d > 0 ? "+" : "";
	return `${sign}${d.toFixed(0)}%`;
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		if (eq >= 0) {
			out[a.slice(2, eq)] = a.slice(eq + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			out[a.slice(2)] = next;
			i++;
		} else {
			out[a.slice(2)] = "true";
		}
	}
	return out;
}
