# DOX Framework

- This repository uses the DOX `AGENTS.md` hierarchy: root instructions apply everywhere, and child `AGENTS.md` files add binding local contracts for their subtrees.
- Before editing, read this file and every `AGENTS.md` on the path to each target. If a parent index points to a child that covers the target, read that child too.
- If instructions conflict, the closest `AGENTS.md` controls local details, but child docs must not weaken root security, quality, release, or DOX rules.
- After meaningful changes, update the closest owning `AGENTS.md` when purpose, contracts, workflows, verification, artifacts, or child indexes changed.
- Keep DOX docs operational: document stable contracts and current checks, not diary notes or aspirational systems.

## Project Purpose

- `codebase-cli` is the open-source terminal agent for Codebase. It provides an interactive TUI, headless mode, model/provider routing, tools, MCP, auth, memories, permissions, hooks, subagents, tournaments, and release packaging.

## Repository Map

- `src/` — TypeScript source for the CLI and all runtime subsystems.
- `bin/` — executable shim published as the `codebase` binary.
- `dist/` — generated build output; do not edit by hand.
- `docs/` — user/developer reference documentation.
- `.settings/` — durable architecture, testing, and extension notes.
- `bench/` — benchmark scenarios, runner, and reports.
- `scripts/` — release/build/support automation.
- `vscode-extension/` — companion editor extension.
- `Formula/` — package-manager/release packaging assets.

## Local Contracts

- Keep the CLI safe-by-default: filesystem, shell, SSH, MCP, hooks, subagents, and git tools must validate paths, permissions, and command effects.
- Preserve cross-platform behavior for macOS/Linux/Windows unless a file explicitly scopes itself.
- Do not log API keys, OAuth tokens, refresh tokens, credentials file contents, MCP secrets, or user clipboard/image data.
- Treat tests as part of the public contract. When behavior changes, update the matching `*.test.ts` file or document the intentional gap.
- Generated `dist/` files are build artifacts. Source changes belong in `src/`.

## Work Guidance

- Prefer small focused modules with colocated tests.
- Keep command UX plain and terminal-friendly; avoid hidden network calls or file mutations without permission flow.
- Use existing abstractions from `pi` packages and local subsystem APIs rather than parallel agent/tool frameworks.

## Verification

- Standard gate: `npm run check`.
- Type-only: `npm run typecheck`.
- Lint/format: `npm run lint`, `npm run lint:fix`, or `npm run format`.
- Tests: `npm test` or targeted `npx vitest --run <file>`.
- Build/release packaging: `npm run build`; `npm run prepublishOnly` before publishing.
- Documentation-only edits: `git diff --check`.

## Child DOX Index

- `src/AGENTS.md` — CLI source architecture and subsystem index.
- `docs/AGENTS.md` — user/developer docs.
- `.settings/AGENTS.md` — durable project standards and planning material.
- `bench/AGENTS.md` — benchmarks.
- `scripts/AGENTS.md` — automation scripts.
- `vscode-extension/AGENTS.md` — companion VS Code extension.
