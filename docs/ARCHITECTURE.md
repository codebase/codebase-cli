# Architecture

The architecture documentation has moved. The canonical source is now:

→ **[`.settings/architecture.md`](../.settings/architecture.md)** — current src
layout, data flow, and component responsibilities for the TypeScript codebase.

Adjacent reading in `.settings/`:

- [`tenets.md`](../.settings/tenets.md) — the decisions already encoded in the code
- [`extending.md`](../.settings/extending.md) — adding a tool, slash command, provider, policy
- [`testing.md`](../.settings/testing.md) — test conventions and the faux-provider E2E pattern

## Historical context

The previous content of this file (988 lines, written April 2026) described
the Go-era architectural blueprint and migration plan: target structure,
tool-system redesign, permission engine, agent FSM, token budget manager,
MCP integration phases, and a 7-stage migration plan.

That blueprint **shipped** — the migration is complete and the codebase is
now TypeScript on top of `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
(the "pi-mono" runtime). Everything described in the old plan now lives in
`src/` with cleaner seams than the original sketch anticipated:

- Tool interface → `src/tools/types.ts` + per-tool modules under `src/tools/`
- Effect-based permissions → `src/permissions/`
- Provider adapters → handled upstream by pi-ai (we don't reimplement them)
- Agent state machine → `src/agent/events.ts` (reducer over typed actions)
- Compaction → `src/compaction/` (single proactive strategy)
- Slash commands → `src/commands/`

For the rationale behind those choices, read [`.settings/tenets.md`](../.settings/tenets.md).
The "what CC got wrong" analysis in the old blueprint is preserved in
condensed form in [`CLAUDE.md`](../CLAUDE.md#competitive-context-claude-code).

The full prior document is available in git history; `git log --follow docs/ARCHITECTURE.md`
finds the commits.
