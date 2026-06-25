# DOX: Clipboard

## Purpose

- Own clipboard copy support and clipboard/image helper behavior.

## Local Contracts

- Clipboard access must be explicit and must degrade gracefully on unsupported/headless platforms.
- Do not persist copied image/text data unless another subsystem explicitly owns that storage.
- Avoid logging clipboard contents.

## Work Guidance

- Keep platform-specific clipboard commands isolated.
- Test unavailable clipboard tools and image payload handling.

## Verification

- Run `npx vitest --run src/clipboard` and related UI clipboard tests.

## Child DOX Index

- No child DOX files yet.
