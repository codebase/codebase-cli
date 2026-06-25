# DOX: Projects

## Purpose

- Own Codebase cloud project API client, project-related CLI commands, and project type contracts.

## Local Contracts

- Cloud project calls must use authenticated clients and must not expose tokens in errors.
- Project IDs, slugs, and paths must be validated before use.
- Network failures should produce actionable messages and nonzero exits when command execution depends on them.

## Work Guidance

- Keep HTTP client behavior injectable for tests.
- Preserve CLI output stability for project commands.

## Verification

- Run `npx vitest --run src/projects`.

## Child DOX Index

- No child DOX files yet.
