# DOX: CLI Source

## Purpose

- Own all TypeScript runtime source for the terminal CLI, including agent orchestration, tools, TUI, auth, MCP, memory, permissions, hooks, config, sessions, and headless/server modes.

## Ownership

- `agent/` owns model-turn orchestration and agent-level features.
- `tools/` owns tool implementations and permission/effect boundaries.
- `ui/` and `ui-pi/` own interactive terminal interfaces.
- `auth/` owns cloud auth, OAuth, token refresh, and credential storage.
- `mcp/` owns MCP config, clients, protocol translation, and tool adaptation.
- `memory/` owns durable memory extraction/injection/store.
- `permissions/` owns command/effect allow/block state.
- `commands/` owns slash-command registry and command handlers.
- `config/` owns local/global config stores and output styles.
- `hooks/` owns lifecycle hook loading/execution.
- `sessions/` and `checkpoint/` own durable conversation/file-state rollback data.
- `skills/`, `subagents/`, `ssh/`, `plan/`, `projects/`, and `app-server/` own their named subsystems.

## Local Contracts

- Public command behavior and CLI flags are user-facing API.
- Tool effects must be explicit and permission-aware.
- Path handling must resolve inside the intended cwd/worktree and handle symlinks/platform temp paths carefully.
- Long-running work must stream status and remain interruptible.
- Tests should avoid relying on host-specific absolute temp path spellings.

## Work Guidance

- Keep tests near source files and name them `<module>.test.ts`.
- Prefer dependency injection for network/filesystem/process boundaries so tests can run offline.
- Avoid importing from `dist/`; source imports should target `src/` modules.

## Verification

- Run targeted Vitest for touched subsystem files.
- Run `npm run check` for cross-cutting source changes.
- Run `npm run build` after changes affecting exported types, bin entrypoints, or package output.

## Child DOX Index

- `agent/AGENTS.md` — agent orchestration, tournament, rewind, prompts, models.
- `tools/AGENTS.md` — tool implementations and permission boundaries.
- `ui/AGENTS.md` — React/Ink TUI.
- `ui-pi/AGENTS.md` — pi-based TUI/runtime widgets.
- `auth/AGENTS.md` — OAuth/cloud credentials.
- `mcp/AGENTS.md` — MCP clients/config/tool bridge.
- `memory/AGENTS.md` — durable memory.
- `permissions/AGENTS.md` — permission stores and command-prefix policy.
- `commands/AGENTS.md` — slash commands and registry.
- `config/AGENTS.md` — config, local LLM, output styles.
- `hooks/AGENTS.md` — lifecycle hooks.
- `sessions/AGENTS.md` — session persistence.
- `checkpoint/AGENTS.md` — file/conversation checkpoint state.
- `compaction/AGENTS.md` — conversation compaction and token budgeting.
- `diagnostics/AGENTS.md` — health/check diagnostics.
- `dotenv/AGENTS.md` — environment file loading.
- `glue/AGENTS.md` — cloud glue APIs for intent/narration.
- `headless/AGENTS.md` — non-interactive CLI runner.
- `projects/AGENTS.md` — cloud project APIs and project commands.
- `clipboard/AGENTS.md` — clipboard copy/image handling.
- `user-queries/AGENTS.md` — queued user query persistence.
- `skills/AGENTS.md` — skill loaders and registry.
- `ssh/AGENTS.md` — SSH host config and command execution.
- `subagents/AGENTS.md` — subagent definitions.
- `plan/AGENTS.md` — plan mode.
- `app-server/AGENTS.md` — local app/server protocol.
