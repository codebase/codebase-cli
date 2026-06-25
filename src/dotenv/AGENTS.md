# DOX: Dotenv

## Purpose

- Own environment file loading and precedence behavior for CLI runtime configuration.

## Local Contracts

- Do not print loaded secret values.
- Keep precedence between process env, project env, and user config deterministic.
- Malformed env files should fail or warn clearly without corrupting process state.

## Work Guidance

- Test quoting, comments, missing files, overrides, and multiline-ish edge cases.

## Verification

- Run `npx vitest --run src/dotenv`.

## Child DOX Index

- No child DOX files yet.
