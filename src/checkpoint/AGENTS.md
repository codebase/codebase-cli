# DOX: Checkpoint

## Purpose

- Own checkpoint storage used to rewind file and conversation state after tool actions.

## Local Contracts

- Checkpoints must capture enough state to undo edits without disturbing unrelated user changes.
- Store paths must stay project-scoped and safe for concurrent sessions where practical.
- Rewind behavior must clearly report what was restored and what could not be restored.

## Work Guidance

- Keep checkpoint metadata explicit and versionable.
- Test dirty-tree, untracked-file, and missing-file scenarios when changing store behavior.

## Verification

- Run `npx vitest --run src/checkpoint` and related `agent/conversation-rewind` tests.

## Child DOX Index

- No child DOX files yet.
