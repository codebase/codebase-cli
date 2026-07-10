# Bench report — launch-2026-07-09-reliable-v15

> Generated 2026-07-09 from `bench/results/<sweep>/runs.jsonl`.

## launch-2026-07-09-reliable-v15

### Methodology

- Source: `bench/results/launch-2026-07-09-reliable-v15/runs.jsonl`
- Runs: 8 across 8 scenarios
- Scenarios: add-test, complex-issue-recovery, durable-task-dependencies, fix-typo, memory-secret-hygiene, multi-file-rename, read-only-explain, task-list-fidelity
- Models: Codebase Auto (codebase/d4f) x8
- Reliable receipts: 8/8 runs
- CLI builds: 2.0.0-pre.73 @ /Users/j/Documents/New project/codebase-cli-usage-pass/dist/cli.js x8
- Repo commits: 7bd845fb8234 x8; dirty runs 0/8
- Runner flags: reliable 8/8, isolated HOME 8/8
- Node versions: v24.2.0 x8
- Public artifact redaction: ruleset v1; writer redactions 1; report-time redactions 0

### Claim-ready summary

| claim | evidence |
|---|---|
| Overall pass rate | 8/8 (100%) across 8 runs |
| Task fidelity | 3/3 (100%) on task-fidelity scenarios; task evidence 3/3 (100%); task verification 3/3 (100%) |
| Memory hygiene | 1/1 (100%) on memory hygiene scenarios |
| Speed | p50 passing run 21.8s |
| Cost | average passing run not reported |
| Receipt proof | receipt ok 8/8 (100%); final proof 6/8 (75%); fresh verification 6/8 (75%) |

### Public scorecard

Launch-facing summary across all runs. Receipt columns show `not collected` unless the sweep used `--reliable true`.

| scope | runs | pass rate | receipt ok | task evidence | task verified | final proof | fresh verified | p50 pass time | avg pass cost |
|---|---|---|---|---|---|---|---|---|---|
| overall | 8 | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) | 21.8s | not reported |
| core edits | 4 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) | 3/4 (75%) | 3/4 (75%) | 3/4 (75%) | 15.5s | not reported |
| task fidelity | 3 | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 30.5s | not reported |
| memory hygiene | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 0/1 (0%) | 0/1 (0%) | 0/1 (0%) | 13.3s | not reported |
| complex recovery | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 56.5s | not reported |

### Outcomes

| scenario | n | passed | failed | harness-errored |
|---|---|---|---|---|
| add-test | 1 | 1 | 0 | 0 |
| complex-issue-recovery | 1 | 1 | 0 | 0 |
| durable-task-dependencies | 1 | 1 | 0 | 0 |
| fix-typo | 1 | 1 | 0 | 0 |
| memory-secret-hygiene | 1 | 1 | 0 | 0 |
| multi-file-rename | 1 | 1 | 0 | 0 |
| read-only-explain | 1 | 1 | 0 | 0 |
| task-list-fidelity | 1 | 1 | 0 | 0 |

### Reliability receipts

| scenario | n | receipt ok | task ok | task evidence | task verified | final proof | verified | fresh verified | avg mutations | avg verifies | avg checkpoints | common failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| add-test | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 3.00 | 1.00 | — |
| complex-issue-recovery | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 5.00 | 1.00 | — |
| durable-task-dependencies | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2.00 | 2.00 | 2.00 | — |
| fix-typo | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 1.00 | 1.00 | — |
| memory-secret-hygiene | 1/1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | — |
| multi-file-rename | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 3.00 | 1.00 | 3.00 | — |
| read-only-explain | 1/1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | — |
| task-list-fidelity | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 3.00 | 1.00 | 3.00 | — |

### Per-scenario means (passing runs only)

| scenario | n_pass | elapsed | tools | input | output | cached | $/run |
|---|---|---|---|---|---|---|---|
| add-test | 1 | 27.6s | 8.00 | not reported | not reported | not reported | not reported |
| complex-issue-recovery | 1 | 56.5s | 31.00 | not reported | not reported | not reported | not reported |
| durable-task-dependencies | 1 | 30.4s | 17.00 | not reported | not reported | not reported | not reported |
| fix-typo | 1 | 14.8s | 6.00 | not reported | not reported | not reported | not reported |
| memory-secret-hygiene | 1 | 13.3s | 6.00 | not reported | not reported | not reported | not reported |
| multi-file-rename | 1 | 16.1s | 11.00 | not reported | not reported | not reported | not reported |
| read-only-explain | 1 | 14.1s | 6.00 | not reported | not reported | not reported | not reported |
| task-list-fidelity | 1 | 30.5s | 34.00 | not reported | not reported | not reported | not reported |

### Tool usage frequency

| tool | calls |
|---|---|
| update_task | 48 |
| read_file | 20 |
| create_task | 17 |
| shell | 13 |
| edit_file | 6 |
| glob | 4 |
| multi_edit | 4 |
| list_files | 3 |
| write_file | 1 |
| save_memory | 1 |
| read_memory | 1 |
| grep | 1 |
