# DOX: Plan Mode

## Purpose

- Own plan-mode prompts, flow, persistent plan store, and plan-mode user interaction types.

## Local Contracts

- Plan mode should gather/clarify before making edits or running effectful tools.
- Stored plans must stay scoped to the current project/session context.
- Transitioning out of plan mode must make the next action clear to the user.

## Work Guidance

- Keep prompts short and decision-oriented.
- Test store persistence and flow transitions.

## Verification

- Run `npx vitest --run src/plan`.

## Child DOX Index

- No child DOX files yet.
