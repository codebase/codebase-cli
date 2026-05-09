# bench/ — end-to-end behavior + benchmark harness

Mirrors the pattern used by `polyvibe-poc/web/backend/scripts/test-react-scaffold-model-e2e.mjs`
and the reports in `polyvibe-poc/docs/benchmarks/` — run real LLM calls
against fixed scenarios, capture metrics, write markdown reports.

This is the **only** thing that proves the CLI actually works as a
coding agent. Vitest covers the wiring (487 tests pass), but a unit
test never sees the LLM round-trip, the tool-call dispatch, the file
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
- **Final assistant text** (truncated to 1KB for readability)
- **Verify exit code + last 500 bytes of stderr** when it failed

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

## Run

Single scenario, single run:

```sh
node bench/run.mjs --scenario fix-typo
```

All scenarios, N=3 each:

```sh
node bench/run.mjs --scenario all --runs 3
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

The aggregator computes per-scenario means over the **passing runs
only** so a single failure doesn't poison the timing data; outcome
counts are reported separately.

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

## Layout

```
bench/
├── run.mjs              # single-run + sweep harness
├── aggregate.mjs        # JSONL → markdown report
├── scenarios/<name>/    # fixture + prompt + verify (one per scenario)
├── results/             # JSONL output, gitignored except .gitkeep
└── README.md            # this file
```

## Self-test (no LLM required)

The harness ships with a fake-CLI smoke test that exercises the
JSON-parsing + verify-running paths without a real LLM call:

```sh
# Implementing as a vitest spec lives next.
```

Right now the self-test is documented inline only — see the smoke
run in commit history (`/tmp/fake-codebase-cli.mjs`). When the
project promotes the harness to `npm run check`, that fake CLI moves
to `bench/_self-test/fake-cli.mjs` and gets a vitest spec.

## CI integration (future)

Plan: a separate GitHub Actions workflow `.github/workflows/bench.yml`
runs the cheap-fast scenario set on PRs, the full set on `main`
nightly. Posts the aggregated report as a PR comment. Stores
historical JSONL in a branch so trend graphs are reproducible.

Not wired up yet — first goal is just "we have proof the agent works
on a few canonical tasks." Trend monitoring comes after the bar is
known to be ≥pass-rate threshold.
