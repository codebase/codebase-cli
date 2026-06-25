# DOX: Pi UI

## Purpose

- Own the pi-based terminal runtime and widgets: app composition, message view, overlays, permission/model/rewind/tournament UI, background shell panel, copy targets, banners, and runtime glue.

## Local Contracts

- Preserve compatibility with `@earendil-works/pi-tui` and `pi-agent-core` event shapes.
- Keep rendering deterministic enough for tests and terminal snapshots.
- Do not duplicate behavior owned by `src/ui/` unless this path is intentionally replacing that surface.

## Work Guidance

- Keep UI state transitions explicit and small.
- Update copy-target tests when changing what can be copied from messages/tool panels.

## Verification

- Run targeted `src/ui-pi/*.test.ts`.
- Run `npm run typecheck` after changes to pi event/message types.

## Child DOX Index

- No child DOX files yet.
