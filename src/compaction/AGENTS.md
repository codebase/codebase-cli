# DOX: Compaction

## Purpose

- Own conversation compaction, microcompaction, token counting, monitor behavior, and compaction type contracts.

## Local Contracts

- Compaction must preserve actionable user intent, tool results needed for continuity, and safety constraints.
- Token estimates should be conservative enough to prevent context overflow.
- Do not drop unresolved user requirements or active task constraints.

## Work Guidance

- Keep compaction summaries structured and easy to test.
- Test boundary cases around large tool output and repeated turns.

## Verification

- Run `npx vitest --run src/compaction`.

## Child DOX Index

- No child DOX files yet.
