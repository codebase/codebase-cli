# DOX: Subagents

## Purpose

- Own subagent definition loading, validation, allowed tools, effort/model bounds, max-turn controls, and worktree options.

## Local Contracts

- Built-in agent types cannot be overridden silently.
- Subagents must not receive disallowed tools or broader permissions than configured.
- Worktree-enabled subagents must isolate writes and report merge/apply behavior explicitly.

## Work Guidance

- Keep validation warnings precise and non-fatal for bad optional definitions.
- Test malformed definitions and unsafe tool requests.

## Verification

- Run `npx vitest --run src/subagents`.
- Run dispatch-agent/tool tests for execution behavior changes.

## Child DOX Index

- No child DOX files yet.
