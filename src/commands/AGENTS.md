# DOX: Commands

## Purpose

- Own slash-command registry, command types, MCP prompt commands, skill commands, and built-in command wiring.

## Local Contracts

- Commands are public CLI UX. Keep names, aliases, help text, and argument behavior stable or update docs/help.
- Commands that mutate files, config, auth, sessions, git, or remote state must route through the right subsystem checks.

## Work Guidance

- Keep command handlers thin; delegate domain logic to subsystem modules.
- Add registry tests for new commands and collisions.

## Verification

- Run `npx vitest --run src/commands`.
- Run `npm run check` for command registry or type changes.

## Child DOX Index

- No child DOX files yet.
