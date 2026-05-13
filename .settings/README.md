# .settings — Orient yourself

You're looking at **codebase-cli**, a TypeScript coding agent that runs in
your terminal. This folder is the fast onboarding path — read these in order
and you'll know enough to ship code:

1. **[tenets.md](tenets.md)** — what we believe about how this should work
2. **[architecture.md](architecture.md)** — what's actually in `src/`
3. **[extending.md](extending.md)** — adding a tool, slash command, or provider
4. **[testing.md](testing.md)** — how to write tests that catch real bugs

If you only have 5 minutes, read `tenets.md`.

## Project-level facts

- **Runtime**: Node ≥ 20, TypeScript, ESM. Built with `tsc`, no bundler.
- **Distribution**: published to npm as `codebase-cli`. `npm i -g codebase-cli`
  installs a `codebase` binary.
- **Foundation**: built on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
  (the "pi-mono" runtime). Those packages handle the agent loop, provider
  protocols, and message types; we layer the TUI, tools, slash commands, and
  permissions on top.
- **Test discipline**: `npm test` runs 576+ unit tests. `npm run check`
  additionally runs typecheck + biome lint. Both must pass before `npm publish`.
- **License**: MIT (see `LICENSE`).

## Where to ask for context

- `CLAUDE.md` in repo root — concrete coding rules (commit standards, dual-graph
  policy, etc.). Note: parts of CLAUDE.md still reference the previous Go
  implementation; the TypeScript rewrite is current. When the two disagree,
  the code is authoritative.
- `docs/ARCHITECTURE.md` — also reflects the previous Go architecture.
  Treat as historical context; rely on `architecture.md` in this folder for
  the current TS layout.
- `docs/benchmarks/` — sweep results from the end-to-end LLM bench harness
  (`bench/run.mjs`). Microbenchmarks live in `src/**/*.bench.ts`
  (`npm run bench:micro`).

## Things that will trip you up

- The TUI uses **ink** (React for terminals). If you've never used it, treat
  `<Text>` and `<Box>` like HTML `<span>` and `<div>` — flexbox-ish layout in
  the terminal grid.
- Agent events stream through a **16ms coalesce** in `use-coalesced-agent-events.ts`.
  If you're debugging "why does the UI lag," instrument that hook first.
- **Permissions** are effect-based, not tool-name-based. A tool declares its
  effects (`reads_fs`, `writes_fs`, `runs_shell`, `network`); permission policies
  match on those. See `src/permissions/`.
- The `glue` sidecar (small/cheap model) and the main agent (smart/expensive
  model) are deliberately separate. Glue handles routing, narration, plan-mode
  Q&A, prompt suggestions. Don't put expensive-model logic in glue.
