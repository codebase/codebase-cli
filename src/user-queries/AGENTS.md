# DOX: User Queries

## Purpose

- Own queued user prompt/query persistence while an agent turn is running.

## Local Contracts

- Queued prompts must preserve order and project/session scope.
- Do not lose queued user input during compaction, interruption, or resume flows.
- Do not persist sensitive text beyond normal session/history expectations.

## Work Guidance

- Keep store behavior small and explicitly tested.

## Verification

- Run `npx vitest --run src/user-queries`.

## Child DOX Index

- No child DOX files yet.
