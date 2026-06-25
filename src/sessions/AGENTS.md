# DOX: Sessions

## Purpose

- Own persisted conversation sessions, metadata, resume/rename/tag flows, and session store behavior.

## Local Contracts

- Session persistence must preserve enough state for resume without leaking secrets.
- Store operations should tolerate missing/corrupt files and concurrent CLI usage where practical.
- Session IDs and paths must be safe for filesystem storage.

## Work Guidance

- Keep serialization formats version-aware.
- Add tests for migration, corruption, and filtering behavior when changing store fields.

## Verification

- Run `npx vitest --run src/sessions`.
- Run command/UI tests if resume/rename UX changes.

## Child DOX Index

- No child DOX files yet.
