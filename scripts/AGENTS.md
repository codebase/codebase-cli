# DOX: Scripts

## Purpose

- Own release, build, migration, and support automation scripts outside `src/`.

## Local Contracts

- Scripts must fail loudly on missing prerequisites and should avoid destructive actions unless explicitly named/flagged.
- Do not print secrets, auth tokens, npm tokens, or local credential contents.
- Keep release scripts aligned with `package.json` scripts.

## Work Guidance

- Prefer idempotent scripts and clear usage output.
- Keep generated outputs out of source control unless intentionally versioned.

## Verification

- Run script help/dry-run where available.
- Run `git diff --check`.

## Child DOX Index

- No child DOX files yet.
