# DOX: Diagnostics

## Purpose

- Own diagnostic checks, diagnostic engine, and typed health/status reports for local CLI operation.

## Local Contracts

- Diagnostics should be safe, read-only by default, and explicit about any commands they run.
- Failure messages should identify the dependency/config that needs attention without leaking secrets.

## Work Guidance

- Keep checkers small and independently testable.
- Prefer actionable remediation text over vague pass/fail labels.

## Verification

- Run `npx vitest --run src/diagnostics`.

## Child DOX Index

- No child DOX files yet.
