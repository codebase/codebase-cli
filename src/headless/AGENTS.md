# DOX: Headless

## Purpose

- Own non-interactive CLI execution for scripted/CI usage.

## Local Contracts

- Headless mode must make permissions, output, exit codes, and failure states explicit.
- Do not assume a TTY, interactive prompts, or clipboard availability.
- Output should be machine-readable or stable enough for automation when documented.

## Work Guidance

- Keep UI-only concerns out of headless paths.
- Test success, failure, interrupted, and permission-denied runs.

## Verification

- Run `npx vitest --run src/headless`.

## Child DOX Index

- No child DOX files yet.
