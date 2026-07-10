# Agent Capability Benchmark Notes

Comparison target inspected locally: `/Users/j/source-code-fun/claude-code-source`.

## What The Target Does Well

Task lists:

- Classic `TodoWrite` guidance tells the model when to create/update a checklist, requires one `in_progress` item, and nudges verification before final summary.
- Newer task tools persist JSON task files under the config dir, with IDs, status, owner, blockers, and blocked-by edges.
- A task-list watcher can claim available unowned tasks, skip blocked tasks, and submit them as prompts.
- The UI prioritizes in-progress and recently completed tasks, truncates long lists, and shows owner/activity for teammate agents.

Memory:

- Session memory keeps a structured markdown note file for compaction/resume continuity.
- Durable memory extraction runs in a forked background agent after settled turns and writes typed memories: user, feedback, project, reference.
- Memory prompts explicitly reject derivable code facts, transient task state, and stale repo snapshots.
- Recall guidance warns that memory is point-in-time context and should be verified against current code before acting on it.
- Team memory sync is OAuth-gated, repo-scoped, delta-synced, size-limited, and guarded by high-confidence secret scanning before upload.

Complex issue handling:

- Microcompaction clears stale tool results while preserving recent working context.
- Full compaction strips/reinjects key context and summarizes older rounds.
- Subagents get focused prompts, allowed tool subsets, progress summaries, and optional isolated worktrees.
- Tool-use summaries provide short progress labels for UI clients.

## Codebase Current Position

Strengths:

- Visible task tools and panels already exist: `create_task`, `update_task`, `list_tasks`, `get_task`.
- Task tools now persist session-scoped JSON task files with owner, blocker, and blocked-by edges.
- Task panels show owner/blocker state, and the task store reloads external task-file edits.
- Main system prompt already asks for one active task, immediate completion updates, and a verification task.
- Memory is typed, file-backed, indexed in `MEMORY.md`, quick-addable with `#`, and auto-extracted after enough settled turns.
- Subagents support read-only/full worker modes, custom definitions, model/effort overrides, and optional isolated worktrees.
- Compaction has both microcompaction and summarize-older-context fallback.
- Checkpoints support `/rewind` for file mutations.

Gaps to keep pressure on:

- There is no autonomous task-list runner yet that claims available unowned tasks and submits prompts.
- Memory has no team-sync layer yet.
- Memory extraction is threshold-based but simpler than the target's session-memory plus durable-memory split.
- Benchmarks should add a durable-task/dependency scenario, not only final artifacts.

## Benchmark Bar

The new capability scenarios in `bench/scenarios/` deliberately grade the areas
above:

- `task-list-fidelity`: final code must pass, and the transcript must show a real task lifecycle.
- `durable-task-dependencies`: task tools must persist owner/blocker edges while fixing dependent work.
- `memory-secret-hygiene`: the agent must call `save_memory`, create durable project memory, and avoid retaining a fake token.
- `complex-issue-recovery`: the agent must inspect before editing, track complex work, make a targeted fix, and run deterministic verification.

Run:

```sh
npm run build
node bench/run.mjs --scenario task-list-fidelity
node bench/run.mjs --scenario durable-task-dependencies
node bench/run.mjs --scenario memory-secret-hygiene
node bench/run.mjs --scenario complex-issue-recovery
```

For direct A/B against another CLI, pass its binary:

```sh
node bench/run.mjs --cli "$(which codebase)" --scenario all --runs 3
```
