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
 *   codebase bench run --scenario fix-typo
 *
 *   # All scenarios × N=3
 *   codebase bench run --scenario all --runs 3
 *
 *   # Specific model
 *   codebase bench run --scenario fix-typo --model claude-sonnet-4-6
 *
 *   # Custom CLI path (default: dist/cli.js, falls back to bin/codebase)
 *   codebase bench run --cli /usr/local/bin/codebase --scenario all
 *
 *   # Public receipt sweep: requires reliable-mode task + verification evidence
 *   codebase bench run --scenario all --reliable true
 *
 * Requires an LLM API key in env (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * etc.) OR a saved credential at ~/.codebase/credentials.json. The
 * runner does not log in for you — that's a one-time setup step.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactBenchmarkRecord, SECRET_REDACTION_RULESET_VERSION } from "./redact.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SCENARIOS_DIR = join(__dirname, "scenarios");
const RESULTS_DIR = process.env.CODEBASE_BENCH_RESULTS_DIR
	? resolve(process.env.CODEBASE_BENCH_RESULTS_DIR)
	: join(__dirname, "results");

// ─── argv ─────────────────────────────────────────────────────────────

const rawArgv = process.argv.slice(2);
if (rawArgv.includes("--help") || rawArgv.includes("-h")) {
	printHelp();
	process.exit(0);
}

const args = parseArgs(rawArgv);
const cliPath = resolveCliPath(args.cli);
const scenarioName = args.scenario ?? "all";
const runs = positiveInt(args.runs, 1);
const modelOverride = args.model;
const sweepId = args["sweep-id"] ?? buildSweepId();
const sweepDir = join(RESULTS_DIR, sweepId);
const timeoutMs = positiveInt(args.timeout, 5 * 60_000);
const keepTmp = args["keep-tmp"] === "true" || args["keep-tmp"] === "1";
const isolateHome = args["isolate-home"] !== "false";
const reliable = args.reliable === "true" || args.reliable === "1";
const baseBenchMetadata = buildBaseBenchMetadata();

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
console.log(`  cli ver:   ${baseBenchMetadata.cliVersion ?? "unknown"}`);
console.log(
	`  commit:    ${baseBenchMetadata.repoCommit ?? "unknown"}${baseBenchMetadata.repoDirty ? " (dirty)" : ""}`,
);
console.log(`  reliable: ${reliable ? "yes" : "no"}`);
console.log(`  results:   ${jsonlPath}`);
console.log("");

let allOk = true;
for (const name of scenarios) {
	for (let i = 1; i <= runs; i++) {
		const result = await runOne(name, i);
		const publicResult = preparePublicResult(result);
		appendJsonl(jsonlPath, publicResult);
		printSummary(publicResult);
		if (!result.ok || !result.verifyPassed) allOk = false;
	}
}

console.log("");
console.log(`done. JSONL → ${jsonlPath}`);
console.log(`generate report: codebase bench report ${sweepId}`);
process.exit(allOk ? 0 : 1);

// ─── one run ──────────────────────────────────────────────────────────

async function runOne(scenarioName, runIndex) {
	const scenarioDir = join(SCENARIOS_DIR, scenarioName);
	const promptPath = join(scenarioDir, "prompt.txt");
	const verifyPath = join(scenarioDir, "verify.sh");
	const setupDir = join(scenarioDir, "setup");
	const setupHomePath = join(scenarioDir, "setup-home.mjs");

	if (!existsSync(promptPath)) {
		return errorResult(scenarioName, runIndex, `missing prompt.txt at ${promptPath}`);
	}
	if (!existsSync(verifyPath)) {
		return errorResult(scenarioName, runIndex, `missing verify.sh at ${verifyPath}`);
	}

	const prompt = readFileSync(promptPath, "utf8").trim();
	const tmpProject = mkdtempSync(join(tmpdir(), `bench-${scenarioName}-`));
	const tmpHome = isolateHome ? mkdtempSync(join(tmpdir(), `bench-home-${scenarioName}-`)) : process.env.HOME || homedir();
	if (isolateHome) prepareBenchHome(tmpHome);

	// Copy setup/ → tmpProject if present.
	if (existsSync(setupDir)) {
		cpSync(setupDir, tmpProject, { recursive: true });
	}
	const setupHome = runScenarioHomeSetup({ setupHomePath, tmpProject, tmpHome });
	if (setupHome) {
		const result = errorResult(scenarioName, runIndex, setupHome);
		cleanupTmp({ tmpProject, tmpHome, isolateHome, keepTmp });
		return result;
	}

	const startedAt = Date.now();
	const startedAtIso = new Date(startedAt).toISOString();
	const cliResult = await invokeCli({ tmpProject, tmpHome, prompt });
	const elapsedMs = Date.now() - startedAt;

	let agentJson = null;
	let agentParseError;
	try {
		agentJson = JSON.parse(cliResult.stdout);
	} catch (err) {
		agentParseError = err instanceof Error ? err.message : String(err);
	}

	const artifactDir = join(tmpProject, ".codebase-bench");
	mkdirSync(artifactDir, { recursive: true });
	const agentJsonPath = join(artifactDir, "agent.json");
	const stdoutPath = join(artifactDir, "stdout.txt");
	const stderrPath = join(artifactDir, "stderr.txt");
	writeFileSync(stdoutPath, cliResult.stdout);
	writeFileSync(stderrPath, cliResult.stderr);
	writeFileSync(
		agentJsonPath,
		agentJson
			? `${JSON.stringify(agentJson, null, 2)}\n`
			: `${JSON.stringify({ ok: false, parseError: agentParseError, rawStdout: cliResult.stdout }, null, 2)}\n`,
	);

	const verify = await runVerify({ tmpProject, tmpHome, verifyPath, agentJsonPath });

	const result = {
		scenario: scenarioName,
		run: runIndex,
		sweepId,
		bench: runBenchMetadata(scenarioName, runIndex, startedAtIso, new Date().toISOString()),
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
		receipt: agentJson?.receipt,
		receiptPassed: agentJson?.receipt?.ok,
		finalText: agentJson?.finalText?.slice(0, 1000),
		agentParseError,
		// verify
		verifyPassed: verify.exitCode === 0,
		verifyExit: verify.exitCode,
		verifyStdout: verify.stdout.slice(-500),
		verifyStderr: verify.stderr.slice(-500),
		// bookkeeping
		tmpProject: keepTmp ? tmpProject : undefined,
		tmpHome: keepTmp && isolateHome ? tmpHome : undefined,
		ts: Date.now(),
	};

	cleanupTmp({ tmpProject, tmpHome, isolateHome, keepTmp });

	return result;
}

function runScenarioHomeSetup({ setupHomePath, tmpProject, tmpHome }) {
	if (!existsSync(setupHomePath)) return null;
	const result = spawnSync(process.execPath, [setupHomePath], {
		cwd: tmpProject,
		env: {
			...process.env,
			HOME: tmpHome,
			CODEBASE_BENCH_HOME: tmpHome,
			CODEBASE_BENCH_PROJECT: tmpProject,
			CODEBASE_BENCH_SCENARIO_DIR: dirname(setupHomePath),
		},
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status === 0) return null;
	const stderr = result.stderr?.trim();
	const stdout = result.stdout?.trim();
	const detail = [stderr, stdout].filter(Boolean).join("\n").slice(-1000);
	return `setup-home.mjs failed${detail ? `: ${detail}` : ""}`;
}

function cleanupTmp({ tmpProject, tmpHome, isolateHome, keepTmp }) {
	if (keepTmp) return;
	try {
		rmSync(tmpProject, { recursive: true, force: true });
	} catch {
		// best effort
	}
	if (!isolateHome) return;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

function errorResult(scenarioName, runIndex, message) {
	const now = new Date().toISOString();
	return {
		scenario: scenarioName,
		run: runIndex,
		sweepId,
		bench: runBenchMetadata(scenarioName, runIndex, now, now),
		ok: false,
		exitCode: -1,
		elapsedMs: 0,
		harnessError: message,
		verifyPassed: false,
		ts: Date.now(),
	};
}

// ─── invocation ───────────────────────────────────────────────────────

function invokeCli({ tmpProject, tmpHome, prompt }) {
	return new Promise((resolveCli) => {
		const env = { ...process.env, HOME: tmpHome, CODEBASE_BENCH_HOME: tmpHome };
		if (modelOverride) {
			// Pi-ai's model registry uses provider+id; user typically passes
			// just an id. We let the user set CODEBASE_MODEL externally for
			// full control; this flag is a convenience.
			env.CODEBASE_MODEL = modelOverride;
		}
		// --auto-approve is non-negotiable for the bench: there's no human
		// at the terminal to answer permission prompts, and without it the
		// agent hangs the moment a write tool fires. The harness is the
		// trust boundary; verify.sh is what catches misuse.
		const cliArgs = [cliPath, "run", "--output", "json", "--auto-approve"];
		if (reliable) cliArgs.push("--reliable");
		cliArgs.push(prompt);
		const child = spawn(process.execPath, cliArgs, {
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

function runVerify({ tmpProject, tmpHome, verifyPath, agentJsonPath }) {
	return new Promise((resolveVerify) => {
		const child = spawn("/bin/sh", [verifyPath], {
			cwd: tmpProject,
			env: {
				...process.env,
				HOME: tmpHome,
				CODEBASE_BENCH_HOME: tmpHome,
				CODEBASE_BENCH_AGENT_JSON: agentJsonPath,
				CODEBASE_BENCH_PROJECT: tmpProject,
				CODEBASE_BENCH_SCENARIO_DIR: dirname(verifyPath),
			},
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

function preparePublicResult(result) {
	const redacted = redactBenchmarkRecord(result);
	const record = redacted.value;
	return {
		...record,
		bench: {
			...(record.bench ?? {}),
			publicArtifact: {
				...(record.bench?.publicArtifact ?? {}),
				secretRedaction: {
					applied: true,
					rulesVersion: SECRET_REDACTION_RULESET_VERSION,
					replacements: redacted.replacements,
				},
			},
		},
	};
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
	const receipt =
		r.receiptPassed === true ? " receipt=ok" : r.receiptPassed === false ? " receipt=fail" : "";
	console.log(`  [${r.scenario} #${r.run}] ${status}${elapsed}${cost}${tools}${receipt}`);
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

function prepareBenchHome(tmpHome) {
	const sourceRoot = join(process.env.HOME || homedir(), ".codebase");
	const destRoot = join(tmpHome, ".codebase");
	mkdirSync(destRoot, { recursive: true });
	for (const name of ["credentials.json", "config.json", "config.local.json"]) {
		const src = join(sourceRoot, name);
		if (!existsSync(src)) continue;
		try {
			copyFileSync(src, join(destRoot, name));
		} catch {
			// A copied credential/config is a convenience for OAuth/BYOK users.
			// Env-var API keys still work when this copy fails.
		}
	}
}

function buildBaseBenchMetadata() {
	const gitStatus = gitText(["status", "--porcelain"]);
	return {
		schemaVersion: 1,
		runner: "bench/run.mjs",
		cliPath,
		cliVersion: cliVersion(cliPath),
		reliable,
		isolateHome,
		timeoutMs,
		nodeVersion: process.version,
		repoRoot: REPO_ROOT,
		repoCommit: gitText(["rev-parse", "--short=12", "HEAD"]),
		repoDirty: gitStatus == null ? null : gitStatus.trim().length > 0,
	};
}

function runBenchMetadata(scenarioName, runIndex, startedAt, endedAt) {
	return {
		...baseBenchMetadata,
		scenario: scenarioName,
		run: runIndex,
		startedAt,
		endedAt,
	};
}

function cliVersion(path) {
	const result = spawnSync(process.execPath, [path, "--version"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) return null;
	const version = result.stdout.trim();
	return version || null;
}

function gitText(args) {
	const result = spawnSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) return null;
	return result.stdout.trim();
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

function printHelp() {
	process.stdout.write(
		[
			"usage: codebase bench run [options]",
			"       node bench/run.mjs [options]",
			"",
			"Run fixed end-to-end coding scenarios through the Codebase CLI and write JSONL results.",
			"",
			"Options:",
			"  --scenario NAME|all     scenario to run (default: all)",
			"  --runs N                runs per scenario (default: 1)",
			"  --reliable true         require reliable-mode task and verification receipts",
			"  --cli PATH              benchmark a specific codebase CLI binary",
			"  --model MODEL           request a specific model id",
			"  --sweep-id ID           stable results id under ./bench/results/",
			"  --timeout MS            per-agent-run timeout (default: 300000)",
			"  --isolate-home false    use your real HOME instead of a copied temp HOME",
			"  --keep-tmp true         keep temporary projects for inspection",
			"  --help, -h              show this help",
			"",
			"Examples:",
			"  codebase bench run --scenario fix-typo",
			"  codebase bench run --scenario all --runs 3 --reliable true",
			"  codebase bench run --cli \"$(which codebase)\" --scenario all",
			"",
		].join("\n"),
	);
}
