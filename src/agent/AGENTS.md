# DOX: Agent

## Purpose

- Own agent turn orchestration, project-file context, prompts, model routing, effort settings, event streams, rewind, WIP snapshots, and tournament workflows.

## Local Contracts

- Agent state changes must emit stable events consumed by UI/headless flows.
- Rewind and checkpoint behavior must keep conversation and filesystem state consistent.
- Tournaments must isolate contestant worktrees and avoid merging failed/unsafe outputs.
- Model selection should respect user config, live overrides, local/cloud capability, and BYOK settings.

## Work Guidance

- Keep prompt changes paired with tests that assert critical invariants.
- Use existing event types rather than ad hoc UI strings as contracts.

## Verification

- Run `npx vitest --run src/agent`.
- For tournament/worktree changes, include real-worktree tests when feasible.

## Child DOX Index

- No child DOX files yet.
