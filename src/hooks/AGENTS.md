# DOX: Hooks

## Purpose

- Own lifecycle hook config loading, validation, execution, environment/cwd handling, and hook result reporting.

## Local Contracts

- Hooks execute user commands; validate config shape and make cwd/env behavior explicit.
- Do not let malformed hook files break unrelated CLI startup paths.
- Preserve platform path behavior by comparing normalized realpaths where needed.

## Work Guidance

- Keep hook execution isolated and timeout-aware.
- Log skipped invalid entries clearly without exposing sensitive env values.

## Verification

- Run `npx vitest --run src/hooks`.
- Add tests for cwd, missing command/event, invalid JSON, and failure exit codes.

## Child DOX Index

- No child DOX files yet.
