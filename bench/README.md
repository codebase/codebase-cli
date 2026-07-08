# bench/ — end-to-end behavior + benchmark harness

Mirrors the pattern used by `polyvibe-poc/web/backend/scripts/test-react-scaffold-model-e2e.mjs`
and the reports in `polyvibe-poc/docs/benchmarks/` — run real LLM calls
against fixed scenarios, capture metrics, write markdown reports.

This is the **only** thing that proves the CLI actually works as a
coding agent. Vitest covers the wiring, but a unit test never sees the
LLM round-trip, the tool-call dispatch, the file
mutations end-to-end. This harness does.

## What it measures

Per-run metrics captured into `bench/results/<sweep>/runs.jsonl`:

- **Outcome**: did the agent complete + did `verify.sh` exit 0?
- **Elapsed wall-clock** (the harness's view, not the agent's
  reported `durationMs`)
- **Tokens**: input / output / cacheRead / cacheWrite / totalTokens
- **Cost**: `$total` from pi-ai's per-message Usage envelope
- **Tool calls**: count + the list of tool names used
- **Model + source** (proxy / explicit env / auto / byok)
- **Run provenance**: CLI path/version, repo commit and dirty state,
  Node.js version, reliable-mode flag, isolated-HOME flag, and timeout
- **Reliability receipt** when run with `--reliable true`: task completion,
  per-task evidence, file-mutation evidence, post-mutation verification
  evidence, completed-task verification evidence, final-answer proof, failed
  tool count, checkpoints, and failure reasons. Obvious secret-looking values
  are redacted before durable receipt storage.
- **Final assistant text** (truncated to 1KB for readability)
- **Verify exit code + last 500 bytes of stderr** when it failed
- **Verify stdout** tail when scenario verifiers emit extra diagnostics

Durable/public benchmark artifacts (`runs.jsonl`, generated markdown, and JSON
scorecards) run through a high-confidence secret redactor for obvious API keys,
PATs, and private keys. The per-run `bench.publicArtifact.secretRedaction`
metadata records the ruleset version and replacement count. Aggregation applies
the same scan again so older sweeps are redacted before report generation.
Temporary `.codebase-bench/agent.json` files stay raw while the verifier runs so
secret-hygiene scenarios can still catch leaks in agent behavior.

The runner also writes the raw agent JSON envelope into each temporary project
at `.codebase-bench/agent.json` and exposes its path as
`CODEBASE_BENCH_AGENT_JSON` to `verify.sh`. Scenarios can grade transcript-level
behavior, such as whether the agent used `create_task`, `update_task`, or
`save_memory`, without relying on brittle final prose.

## Prerequisites

You need a working LLM. Pick one:

```sh
# A: an env-var API key
export ANTHROPIC_API_KEY=sk-ant-…       # or OPENAI_API_KEY, GROQ_API_KEY, …

# B: a saved OAuth credential (`codebase auth login` once)
ls ~/.codebase/credentials.json

# C: a saved BYOK from the wizard (run `codebase` once, pick option 2)
```

If none of those resolve, the harness will fail with a config error
on the first run.

You also need `dist/cli.js` built:

```sh
npm run build
```

By default every run gets an isolated temporary `HOME` so memory, sessions,
checkpoints, and config writes do not pollute your real `~/.codebase`. The
runner copies `credentials.json`, `config.json`, and `config.local.json` into
that temp home when present, so OAuth/BYOK runs still work. To deliberately use
your real home directory:

```sh
node bench/run.mjs --scenario all --isolate-home false
```

## Run

Single scenario, single run:

```sh
node bench/run.mjs --scenario fix-typo
```

All scenarios, N=3 each:

```sh
node bench/run.mjs --scenario all --runs 3
```

Public receipt sweep (requires task lifecycle + passing verification evidence):

```sh
node bench/run.mjs --scenario all --runs 3 --reliable true
```

Pin a model (overrides auto-detect):

```sh
node bench/run.mjs --scenario fix-typo --model claude-sonnet-4-6
# or via env:
CODEBASE_PROVIDER=anthropic CODEBASE_MODEL=claude-sonnet-4-6 \
  node bench/run.mjs --scenario all
```

Run with a custom CLI binary (e.g. an installed npm version vs. the
local `dist/`):

```sh
node bench/run.mjs --cli "$(which codebase)" --scenario all
```

Keep the tmp project directories for inspection:

```sh
node bench/run.mjs --scenario fix-typo --keep-tmp true
```

Pin a stable sweep id (so subsequent runs append to the same JSONL):

```sh
node bench/run.mjs --scenario all --sweep-id 2026-05-09-baseline
```

## Aggregate

After a sweep finishes:

```sh
node bench/aggregate.mjs <sweep-id>
```

Compare two sweeps (A/B):

```sh
node bench/aggregate.mjs sweep-control sweep-treatment
```

Write the report into the project-wide benchmarks directory:

```sh
node bench/aggregate.mjs sweep-foo \
  --out ../docs/benchmarks/2026-05-09-foo.md
```

Also write machine-readable launch metrics for the web app or docs pipeline:

```sh
node bench/aggregate.mjs sweep-foo \
  --out ../docs/benchmarks/2026-05-09-foo.md \
  --json-out ../docs/benchmarks/2026-05-09-foo.json
```

The aggregator computes per-scenario means over the **passing runs
only** so a single failure doesn't poison the timing data; outcome
counts are reported separately.

The methodology section is part of the evidence, not filler. New sweeps record
the CLI build, repo commit, dirty state, Node version, reliable-mode flag, and
home-isolation flag in each JSONL row; the markdown and JSON scorecard surface
those values plus public-artifact redaction counts so launch claims can be
traced back to the exact build tested without publishing obvious secrets.

The first table is the public scorecard. It is meant to be readable by a
launch reviewer without opening the JSONL:

- **overall**: every scenario in the sweep
- **core edits**: `add-test`, `fix-typo`, `multi-file-rename`,
  `read-only-explain`
- **task fidelity**: `task-list-fidelity`,
  `durable-task-dependencies`, `complex-issue-recovery`
- **memory hygiene**: `memory-secret-hygiene`
- **complex recovery**: `complex-issue-recovery`

The public scorecard reports pass rate, reliable receipt health, task evidence,
completed-task verification, final-answer proof, fresh post-mutation
verification, p50 passing time, and average passing cost. Receipt columns show
`not collected` unless the sweep used `--reliable true`.
For launch-facing claims, prefer:

```sh
npm run build
sweep_id=launch-$(date +%Y-%m-%d)
node bench/run.mjs --scenario all --runs 3 --reliable true --sweep-id "$sweep_id"
node bench/aggregate.mjs "$sweep_id" \
  --out "docs/benchmarks/$sweep_id.md" \
  --json-out "docs/benchmarks/$sweep_id.json"
```

When a sweep includes reliable-mode receipts, the report also includes a
receipt scorecard: receipt pass count, task lifecycle pass count, task evidence
count, completed-task verification count, final-answer proof count,
verification count, fresh post-mutation verification count, average mutations,
average checkpoints, and common failure reasons. Reliable receipts also flag
stale verification that ran before the final file mutation. This is the
launch-facing table to publish when comparing agent builds.

## Add a new scenario

Each scenario lives in `bench/scenarios/<name>/` with three pieces:

```
bench/scenarios/<name>/
├── prompt.txt        # what to give the agent (one paragraph, plain text)
├── verify.sh         # exits 0 = pass, anything else = fail
└── setup/            # files copied into the tmp project before the run
    └── …
```

Design rules for scenarios:

1. **Deterministic verify.** `verify.sh` must check OBSERVABLE
   artifacts (file contents, command exit codes, grep matches).
   Don't grade by inspecting the agent's chat output — that varies
   run-to-run.
2. **Small fixtures.** A scenario that takes 8 minutes per run isn't
   useful for sweeps. Aim for ≤30s per run on a fast model.
3. **Self-contained.** No network calls. No "run npm install in the
   tmp project" — the agent already has tools for that and we
   shouldn't double up.
4. **Failure-mode coverage.** A scenario should fail loudly when the
   agent does the wrong thing. A scenario that always passes
   regardless of agent behavior is just a green checkbox.
5. **One commit per scenario.** Easy to revert if a scenario turns
   out to be flaky.

The `verify.sh` runs in the tmp project's cwd. Use `set -e` and exit
non-zero with a clear message on failure.

Useful verifier environment:

- `CODEBASE_BENCH_AGENT_JSON`: parsed JSON-mode output from `codebase run`
- `CODEBASE_BENCH_HOME`: the isolated home used for this run
- `CODEBASE_BENCH_PROJECT`: the temporary project cwd
- `CODEBASE_BENCH_SCENARIO_DIR`: source scenario directory

## Capability Scenarios

The launch-readiness set includes behavior-focused scenarios inspired by
Claude Code's task and memory systems:

- `task-list-fidelity`: multi-step bug fix that must use task tools, keep
  progress moving through `in_progress`, complete tasks, and include
  verification as tracked work.
- `memory-secret-hygiene`: requires a durable `save_memory` call while
  ensuring a fake token in the prompt is not retained in memory files.
- `complex-issue-recovery`: multi-file config bug with deterministic tests;
  grades code inspection, task tracking, minimal repair, and verification.

## Layout

```
bench/
├── run.mjs              # single-run + sweep harness
├── aggregate.mjs        # JSONL → markdown report
├── scenarios/<name>/    # fixture + prompt + verify (one per scenario)
├── results/             # JSONL output, gitignored except .gitkeep
└── README.md            # this file
```

## Self-tests (no LLM required)

The benchmark surface has no-LLM Vitest smoke tests:

```sh
npx vitest --run bench/run.test.mjs bench/aggregate.test.mjs
```

- `bench/run.test.mjs` runs the real `fix-typo` scenario through a fake
  Codebase CLI and verifies setup copying, JSON parsing, `verify.sh`,
  receipt capture, JSONL output, and provenance.
- `bench/aggregate.test.mjs` creates a synthetic JSONL sweep and verifies
  markdown + JSON scorecard provenance.

## CI integration (future)

Plan: a separate GitHub Actions workflow `.github/workflows/bench.yml`
runs the cheap-fast scenario set on PRs, the full set on `main`
nightly. Posts the aggregated report as a PR comment. Stores
historical JSONL in a branch so trend graphs are reproducible.

Not wired up yet — first goal is just "we have proof the agent works
on a few canonical tasks." Trend monitoring comes after the bar is
known to be ≥pass-rate threshold.
