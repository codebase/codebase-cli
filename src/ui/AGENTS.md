# DOX: Ink UI

## Purpose

- Own the React/Ink terminal UI: app shell, message rendering, input, status, task/tool panels, model picker, permission prompts, history search, first-run setup, markdown, attachments, and clipboard helpers.

## Local Contracts

- UI must remain keyboard-first, readable in narrow terminals, and safe for non-TTY/headless boundaries.
- Do not print secrets or full credential values.
- Keep copy-mode and shortcut behavior stable unless docs/help are updated.
- Long output must truncate or virtualize rather than flooding the terminal.

## Work Guidance

- Prefer pure rendering helpers and tested state reducers where possible.
- Keep ANSI/control-sequence assumptions isolated.

## Verification

- Run targeted `src/ui/*.test.tsx` or `src/ui/*.test.ts`.
- Manually smoke `npm run dev` for substantial TUI interaction changes when feasible.

## Child DOX Index

- No child DOX files yet.
