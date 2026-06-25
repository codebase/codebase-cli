# DOX: Glue

## Purpose

- Own lightweight cloud/API glue for intent classification, narration, and helper calls that augment the local agent experience.

## Local Contracts

- Glue calls must respect auth/config state and degrade gracefully when unavailable.
- Do not send secrets or unnecessary project content.
- Narration/intent outputs are advisory; core permission and tool policy remains local.

## Work Guidance

- Keep request/response schemas narrow and test parsing/fallback behavior.
- Avoid blocking core CLI workflows on optional glue features.

## Verification

- Run `npx vitest --run src/glue`.

## Child DOX Index

- No child DOX files yet.
