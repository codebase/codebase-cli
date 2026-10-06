# DOX: Agent

## Purpose

- Own agent turn orchestration, project-file context, prompts, model routing, effort settings, event streams, rewind, WIP snapshots, and tournament workflows.

## Local Contracts

- Agent state changes must emit stable events consumed by UI/headless flows.
- Rewind and checkpoint behavior must keep conversation and filesystem state consistent.
- Tournaments must isolate contestant worktrees and avoid merging failed/unsafe outputs.
- Model selection should respect user config, live overrides, local/cloud capability, and BYOK settings.
- Proxy spending uses confirmed server receipts, never dollar estimates. Missing receipts are unconfirmed. Share the billing ledger across main/helper/subagent requests and preserve the safe proxy stream wrapper. Totals cover the current agent lifetime only.

## Work Guidance

- Keep prompt changes paired with tests that assert critical invariants.
- Use existing event types rather than ad hoc UI strings as contracts.

## Verification

- Run `npx vitest --run src/agent`.
- For tournament/worktree changes, include real-worktree tests when feasible.

## Child DOX Index

- No child DOX files yet.
