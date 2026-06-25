# DOX: CLI Docs

## Purpose

- Own user/developer documentation for installing, migrating, configuring, and operating the CLI.

## Local Contracts

- Keep command names, flags, shortcuts, and config paths aligned with source code.
- Do not document unreleased behavior as available unless clearly marked.
- Avoid fabricated claims about provider support, benchmarks, or security guarantees.

## Work Guidance

- Prefer runnable examples and concise troubleshooting steps.
- Link to source-owned settings when docs describe extension/config behavior.

## Verification

- Run `git diff --check`.
- For command docs, verify the command exists in `src/commands/` or CLI help.

## Child DOX Index

- No child DOX files yet.
