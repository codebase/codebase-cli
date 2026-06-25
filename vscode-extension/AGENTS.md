# DOX: VS Code Extension

## Purpose

- Own the companion VS Code extension source, media, packaging, and extension docs.

## Local Contracts

- Extension commands and webviews must not expose workspace secrets or execute commands without user intent.
- Keep extension protocol compatibility with the CLI/app-server surfaces it depends on.
- Media assets should be lightweight and source-controlled intentionally.

## Work Guidance

- Keep editor-specific UX separate from terminal CLI source unless sharing a protocol/type is deliberate.
- Update `vscode-extension/README.md` for user-visible extension behavior changes.

## Verification

- Run extension build/test scripts if present.
- Run root `npm run typecheck` when shared protocol/types change.

## Child DOX Index

- No child DOX files yet.
