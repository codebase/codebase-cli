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
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, "results");

const args = parseArgs(process.argv.slice(2));
const positional = args._;
const outPath = args.out ? resolve(args.out) : null;

if (positional.length === 0) {
	console.error("usage: aggregate.mjs <sweep-id> [<sweep-id> …] [--out path.md]");
	process.exit(1);
}

const sweeps = positional.map((id) => loadSweep(id));
const md = renderReport(sweeps);

if (outPath) {
	writeFileSync(outPath, md);
	console.error(`wrote ${outPath}`);
} else {
	process.stdout.write(md);
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

// ─── render ───────────────────────────────────────────────────────────

function renderReport(sweeps) {
	const lines = [];
	const date = new Date().toISOString().slice(0, 10);
	const title = sweeps.length === 1 ? `Bench report — ${sweeps[0].id}` : `Bench comparison — ${sweeps.map((s) => s.id).join(" vs ")}`;

	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Generated ${date} from \`bench/results/<sweep>/runs.jsonl\`.`);
	lines.push("");

	for (const sweep of sweeps) {
		lines.push(`## ${sweep.id}`);
		lines.push("");
		lines.push(...renderOutcomesTable(sweep.runs));
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

function renderOutcomesTable(runs) {
	const grouped = groupBy(runs, (r) => r.scenario);
	const out = ["### Outcomes", "", "| scenario | n | passed | failed | harness-errored |", "|---|---|---|---|---|"];
	for (const [scenario, items] of grouped) {
		const passed = items.filter((r) => r.ok && r.verifyPassed).length;
		const failed = items.filter((r) => !r.harnessError && (!r.ok || !r.verifyPassed)).length;
		const errored = items.filter((r) => r.harnessError).length;
		out.push(`| ${scenario} | ${items.length} | ${passed} | ${failed} | ${errored} |`);
	}
	return out;
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
		const passing = items.filter((r) => r.ok && r.verifyPassed);
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
		const aPass = (aGrouped.get(scenario) ?? []).filter((r) => r.ok && r.verifyPassed);
		const bPass = (bGrouped.get(scenario) ?? []).filter((r) => r.ok && r.verifyPassed);
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

function fmt(n) {
	if (!Number.isFinite(n)) return "—";
	return Math.round(n).toLocaleString();
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
