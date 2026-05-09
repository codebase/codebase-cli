#!/usr/bin/env node
/**
 * Single-run + sweep harness for codebase-cli end-to-end behavior.
 *
 * Each run:
 *   1. Pick a scenario from bench/scenarios/<name>/
 *   2. Copy its setup/ tree into a fresh tmp project
 *   3. Run `codebase run --output json` with the scenario prompt and
 *      the tmp project as cwd, against a real LLM
 *   4. Run the scenario's verify.sh in the tmp project; exit code 0
 *      = pass, anything else = fail (stderr captured for the report)
 *   5. Emit one JSONL line to bench/results/<sweep-id>/runs.jsonl
 *
 * Sweeps run the matrix scenario × model × N. The aggregator
 * (bench/aggregate.mjs) turns the JSONL into a markdown report.
 *
 * Usage:
 *   # Single run, default scenario, current model from env
 *   node bench/run.mjs --scenario fix-typo
 *
 *   # All scenarios × N=3
 *   node bench/run.mjs --scenario all --runs 3
 *
 *   # Specific model
 *   node bench/run.mjs --scenario fix-typo --model claude-sonnet-4-6
 *
 *   # Custom CLI path (default: dist/cli.js, falls back to bin/codebase)
 *   node bench/run.mjs --cli /usr/local/bin/codebase --scenario all
 *
 * Requires an LLM API key in env (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * etc.) OR a saved credential at ~/.codebase/credentials.json. The
 * runner does not log in for you — that's a one-time setup step.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SCENARIOS_DIR = join(__dirname, "scenarios");
const RESULTS_DIR = join(__dirname, "results");

// ─── argv ─────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const cliPath = resolveCliPath(args.cli);
const scenarioName = args.scenario ?? "all";
const runs = positiveInt(args.runs, 1);
const modelOverride = args.model;
const sweepId = args["sweep-id"] ?? buildSweepId();
const sweepDir = join(RESULTS_DIR, sweepId);
const timeoutMs = positiveInt(args.timeout, 5 * 60_000);
const keepTmp = args["keep-tmp"] === "true" || args["keep-tmp"] === "1";

mkdirSync(sweepDir, { recursive: true });
const jsonlPath = join(sweepDir, "runs.jsonl");

// ─── main ─────────────────────────────────────────────────────────────

const scenarios = scenarioName === "all" ? listScenarios() : [scenarioName];
if (scenarios.length === 0) {
	console.error(`no scenarios found under ${SCENARIOS_DIR}`);
	process.exit(1);
}

console.log(`bench sweep ${sweepId}`);
console.log(`  scenarios: ${scenarios.join(", ")}`);
console.log(`  runs each: ${runs}`);
console.log(`  cli:       ${cliPath}`);
console.log(`  results:   ${jsonlPath}`);
console.log("");

let allOk = true;
for (const name of scenarios) {
	for (let i = 1; i <= runs; i++) {
		const result = await runOne(name, i);
		appendJsonl(jsonlPath, result);
		printSummary(result);
		if (!result.ok || !result.verifyPassed) allOk = false;
	}
}

console.log("");
console.log(`done. JSONL → ${jsonlPath}`);
console.log(`generate report: node bench/aggregate.mjs ${sweepId}`);
process.exit(allOk ? 0 : 1);

// ─── one run ──────────────────────────────────────────────────────────

async function runOne(scenarioName, runIndex) {
	const scenarioDir = join(SCENARIOS_DIR, scenarioName);
	const promptPath = join(scenarioDir, "prompt.txt");
	const verifyPath = join(scenarioDir, "verify.sh");
	const setupDir = join(scenarioDir, "setup");

	if (!existsSync(promptPath)) {
		return errorResult(scenarioName, runIndex, `missing prompt.txt at ${promptPath}`);
	}
	if (!existsSync(verifyPath)) {
		return errorResult(scenarioName, runIndex, `missing verify.sh at ${verifyPath}`);
	}

	const prompt = readFileSync(promptPath, "utf8").trim();
	const tmpProject = mkdtempSync(join(tmpdir(), `bench-${scenarioName}-`));

	// Copy setup/ → tmpProject if present.
	if (existsSync(setupDir)) {
		cpSync(setupDir, tmpProject, { recursive: true });
	}

	const startedAt = Date.now();
	const cliResult = await invokeCli({ tmpProject, prompt });
	const elapsedMs = Date.now() - startedAt;

	let agentJson = null;
	let agentParseError;
	try {
		agentJson = JSON.parse(cliResult.stdout);
	} catch (err) {
		agentParseError = err instanceof Error ? err.message : String(err);
	}

	const verify = await runVerify({ tmpProject, verifyPath });

	const result = {
		scenario: scenarioName,
		run: runIndex,
		sweepId,
		model: agentJson?.model ?? { provider: "?", id: modelOverride ?? "?", name: "?" },
		source: agentJson?.source,
		ok: cliResult.exitCode === 0,
		exitCode: cliResult.exitCode,
		elapsedMs,
		// agent metrics
		agentDurationMs: agentJson?.durationMs,
		usage: agentJson?.usage,
		messageCount: agentJson?.messageCount,
		toolCalls: countToolCalls(agentJson),
		toolNames: collectToolNames(agentJson),
		finalText: agentJson?.finalText?.slice(0, 1000),
		agentParseError,
		// verify
		verifyPassed: verify.exitCode === 0,
		verifyExit: verify.exitCode,
		verifyStderr: verify.stderr.slice(-500),
		// bookkeeping
		tmpProject: keepTmp ? tmpProject : undefined,
		ts: Date.now(),
	};

	if (!keepTmp) {
		try {
			rmSync(tmpProject, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}

	return result;
}

function errorResult(scenarioName, runIndex, message) {
	return {
		scenario: scenarioName,
		run: runIndex,
		sweepId,
		ok: false,
		exitCode: -1,
		elapsedMs: 0,
		harnessError: message,
		verifyPassed: false,
		ts: Date.now(),
	};
}

// ─── invocation ───────────────────────────────────────────────────────

function invokeCli({ tmpProject, prompt }) {
	return new Promise((resolveCli) => {
		const env = { ...process.env };
		if (modelOverride) {
			// Pi-ai's model registry uses provider+id; user typically passes
			// just an id. We let the user set CODEBASE_MODEL externally for
			// full control; this flag is a convenience.
			env.CODEBASE_MODEL = modelOverride;
		}
		const child = spawn(process.execPath, [cliPath, "run", "--output", "json", prompt], {
			cwd: tmpProject,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			child.kill("SIGINT");
			setTimeout(() => child.kill("SIGKILL"), 3_000);
		}, timeoutMs);

		child.on("exit", (code) => {
			clearTimeout(timer);
			resolveCli({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

function runVerify({ tmpProject, verifyPath }) {
	return new Promise((resolveVerify) => {
		const child = spawn("/bin/sh", [verifyPath], {
			cwd: tmpProject,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolveVerify({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

// ─── helpers ──────────────────────────────────────────────────────────

function countToolCalls(agentJson) {
	if (!agentJson?.messages) return 0;
	let n = 0;
	for (const msg of agentJson.messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block?.type === "toolCall") n++;
		}
	}
	return n;
}

function collectToolNames(agentJson) {
	if (!agentJson?.messages) return [];
	const names = [];
	for (const msg of agentJson.messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block?.type === "toolCall" && typeof block.name === "string") {
				names.push(block.name);
			}
		}
	}
	return names;
}

function listScenarios() {
	if (!existsSync(SCENARIOS_DIR)) return [];
	let entries;
	try {
		entries = readdirSync(SCENARIOS_DIR);
	} catch {
		return [];
	}
	return entries.filter((name) => existsSync(join(SCENARIOS_DIR, name, "prompt.txt"))).sort();
}

function appendJsonl(path, record) {
	writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

function printSummary(r) {
	const status = r.harnessError
		? `ERROR: ${r.harnessError}`
		: !r.ok
			? `FAIL exit=${r.exitCode}`
			: r.verifyPassed
				? "✓ PASS"
				: "✗ verify failed";
	const tools = r.toolNames?.length ? ` tools=${r.toolNames.length} (${[...new Set(r.toolNames)].join(",")})` : "";
	const cost = r.usage?.cost?.total != null ? ` $${r.usage.cost.total.toFixed(4)}` : "";
	const elapsed = ` ${(r.elapsedMs / 1000).toFixed(1)}s`;
	console.log(`  [${r.scenario} #${r.run}] ${status}${elapsed}${cost}${tools}`);
}

function buildSweepId() {
	const now = new Date();
	const pad = (n) => `${n}`.padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(
		now.getMinutes(),
	)}-${pad(now.getSeconds())}`;
	return `sweep-${ts}`;
}

function resolveCliPath(override) {
	if (override) return resolve(override);
	const dist = join(REPO_ROOT, "dist", "cli.js");
	if (existsSync(dist)) return dist;
	const bin = join(REPO_ROOT, "bin", "codebase");
	if (existsSync(bin)) return bin;
	console.error(
		`could not find a CLI to invoke. Build first (npm run build) or pass --cli /path/to/cli`,
	);
	process.exit(1);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq >= 0) {
			out[a.slice(2, eq)] = a.slice(eq + 1);
			continue;
		}
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			out[key] = next;
			i++;
		} else {
			out[key] = "true";
		}
	}
	return out;
}

function positiveInt(value, fallback) {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
