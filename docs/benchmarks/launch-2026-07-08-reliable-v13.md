# Bench report — launch-2026-07-08-reliable-v13

> Generated 2026-07-09 from `bench/results/<sweep>/runs.jsonl`.

## launch-2026-07-08-reliable-v13

### Methodology

- Source: `bench/results/launch-2026-07-08-reliable-v13/runs.jsonl`
- Runs: 8 across 8 scenarios
- Scenarios: add-test, complex-issue-recovery, durable-task-dependencies, fix-typo, memory-secret-hygiene, multi-file-rename, read-only-explain, task-list-fidelity
- Models: Codebase Auto (codebase/d4f) x8
- Reliable receipts: 8/8 runs
- CLI builds: 2.0.0-pre.73 @ /Users/j/Documents/New project/codebase-cli-usage-pass/dist/cli.js x8
- Repo commits: d65a8a8a9c2d x8; dirty runs 0/8
- Runner flags: reliable 8/8, isolated HOME 8/8
- Node versions: v24.2.0 x8
- Public artifact redaction: ruleset v1; writer redactions 1; report-time redactions 0

### Claim-ready summary

| claim | evidence |
|---|---|
| Overall pass rate | 7/8 (88%) across 8 runs |
| Task fidelity | 3/3 (100%) on task-fidelity scenarios; task evidence 3/3 (100%); task verification 3/3 (100%) |
| Memory hygiene | 1/1 (100%) on memory hygiene scenarios |
| Speed | p50 passing run 25.8s |
| Cost | average passing run not reported |
| Receipt proof | receipt ok 7/8 (88%); final proof 5/8 (63%); fresh verification 5/8 (63%) |

### Public scorecard

Launch-facing summary across all runs. Receipt columns show `not collected` unless the sweep used `--reliable true`.

| scope | runs | pass rate | receipt ok | task evidence | task verified | final proof | fresh verified | p50 pass time | avg pass cost |
|---|---|---|---|---|---|---|---|---|---|
| overall | 8 | 7/8 (88%) | 7/8 (88%) | 8/8 (100%) | 5/8 (63%) | 5/8 (63%) | 5/8 (63%) | 25.8s | not reported |
| core edits | 4 | 3/4 (75%) | 3/4 (75%) | 4/4 (100%) | 2/4 (50%) | 2/4 (50%) | 2/4 (50%) | 17.7s | not reported |
| task fidelity | 3 | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 30.1s | not reported |
| memory hygiene | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 0/1 (0%) | 0/1 (0%) | 0/1 (0%) | 9.5s | not reported |
| complex recovery | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) | 25.8s | not reported |

### Outcomes

| scenario | n | passed | failed | harness-errored |
|---|---|---|---|---|
| add-test | 1 | 1 | 0 | 0 |
| complex-issue-recovery | 1 | 1 | 0 | 0 |
| durable-task-dependencies | 1 | 1 | 0 | 0 |
| fix-typo | 1 | 1 | 0 | 0 |
| memory-secret-hygiene | 1 | 1 | 0 | 0 |
| multi-file-rename | 1 | 0 | 1 | 0 |
| read-only-explain | 1 | 1 | 0 | 0 |
| task-list-fidelity | 1 | 1 | 0 | 0 |

### Reliability receipts

| scenario | n | receipt ok | task ok | task evidence | task verified | final proof | verified | fresh verified | avg mutations | avg verifies | avg checkpoints | common failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| add-test | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2.00 | 1.00 | 2.00 | — |
| complex-issue-recovery | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 1.00 | 1.00 | — |
| durable-task-dependencies | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 1.00 | 1.00 | — |
| fix-typo | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1.00 | 1.00 | 1.00 | — |
| memory-secret-hygiene | 1/1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | — |
| multi-file-rename | 1/1 | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 3.00 | 0.00 | 3.00 | no successful verification command was recorded (1) |
| read-only-explain | 1/1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | — |
| task-list-fidelity | 1/1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 3.00 | 1.00 | 3.00 | — |

### Per-scenario means (passing runs only)

| scenario | n_pass | elapsed | tools | input | output | cached | $/run |
|---|---|---|---|---|---|---|---|
| add-test | 1 | 30.3s | 8.00 | not reported | not reported | not reported | not reported |
| complex-issue-recovery | 1 | 25.8s | 14.00 | not reported | not reported | not reported | not reported |
| durable-task-dependencies | 1 | 30.1s | 14.00 | not reported | not reported | not reported | not reported |
| fix-typo | 1 | 14.2s | 6.00 | not reported | not reported | not reported | not reported |
| memory-secret-hygiene | 1 | 9.5s | 4.00 | not reported | not reported | not reported | not reported |
| multi-file-rename | 0 | — | — | — | — | — | — |
| read-only-explain | 1 | 17.7s | 9.00 | not reported | not reported | not reported | not reported |
| task-list-fidelity | 1 | 45.5s | 38.00 | not reported | not reported | not reported | not reported |

### Tool usage frequency

| tool | calls |
|---|---|
| update_task | 37 |
| read_file | 23 |
| create_task | 15 |
| edit_file | 10 |
| shell | 9 |
| multi_edit | 5 |
| list_files | 4 |
| glob | 4 |
| write_file | 2 |
| grep | 2 |
| save_memory | 1 |
