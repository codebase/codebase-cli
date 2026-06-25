# DOX: Config

## Purpose

- Own config stores, typed config data, local LLM detection/config, output styles, and frontmatter parsing.

## Local Contracts

- Config writes must be atomic where practical and preserve unknown user-managed data unless intentionally migrating.
- Local LLM detection must not hang CLI startup.
- Output style config must not inject unsafe prompt/system behavior beyond the intended style scope.

## Work Guidance

- Keep migrations/version handling explicit.
- Test invalid JSON, missing files, old versions, and malformed frontmatter.

## Verification

- Run `npx vitest --run src/config`.
- Run `npm run typecheck` for config type changes.

## Child DOX Index

- No child DOX files yet.
