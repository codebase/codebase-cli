# Testing

## Stack

- **Runner**: vitest 2.x. Config: `vitest.config.ts`. Tests are `*.test.ts`
  / `*.test.tsx` colocated with source.
- **Bench runner**: vitest's built-in bench. Files are `*.bench.ts`. Run
  with `npm run bench:micro` (separate from `npm test`).
- **Lint**: biome (`biome.json`). Run with `npm run lint`, autofix with
  `npm run lint:fix`.
- **Type check**: `npm run typecheck` (`tsc --noEmit`).
- **Full pre-publish gate**: `npm run check` (typecheck + lint + test).

## Run them

```sh
npm test                     # all unit tests
npm test -- --watch          # watch mode (or `npm run test:watch`)
npm test -- src/agent        # filter by path
npm test -- -t "user-prompt" # filter by test name
npm run bench:micro          # microbenchmarks
npm run bench                # end-to-end LLM benchmarks (needs API key)
```

## Conventions

### Colocation

`src/foo/bar.ts` ↔ `src/foo/bar.test.ts`. Always next to the source.
Centralized `test/` folders are an anti-pattern in this repo.

### Test names describe behavior, not the function

Good: `it("appends a user message and flips status to thinking")`
Bad: `it("user-prompt action works")`

The test name is the spec. Write it so a failure tells you what broke
without reading the test body.

### Use the typed mock context, not `{} as any`

`src/tools/__test__/mock-tool-context.ts` provides `makeToolContext()` for
constructing a tool context with sensible defaults you can override field
by field. Don't hand-roll. If a tool needs a context field that mock
doesn't have, add it to the factory.

For commands, `src/commands/registry.test.ts::fakeCtx()` is the pattern.

### Don't mock the filesystem in filesystem tools

`vitest` runs tests in parallel by default, but the filesystem tools use
`mkdtemp` and clean up in `afterEach`. Look at `src/tools/read-file.test.ts`
or `src/tools/edit-file.test.ts` for the template. Mocked filesystems
historically hide real bugs (path normalization, symlink handling, race
conditions) — we don't.

### E2E: use pi-ai's faux provider

`src/agent/__test__/agent-e2e.test.ts` is the reference. `registerFauxProvider`
from `@earendil-works/pi-ai` lets you drive the full agent loop —
real reducer, real tool execution, real session persistence — with a
scripted LLM response stream. No network. Deterministic.

When you need an integration test that crosses agent + tools + UI state,
this is the right tool. Don't reinvent it.

### Reducers and pure functions get exhaustive tests

`src/agent/events.test.ts` covers every Action variant and every
AgentEvent type. If you add a branch, add a test in the same PR. The
reducer is load-bearing — every state transition for every user goes
through it.

### The TUI doesn't have automated tests yet

Render-layer testing (snapshotting `<App>` output, simulating keystrokes
via `ink-testing-library`) is a known gap. Don't claim a UI change
"works" because tests pass — type-check ≠ feature-correct for the
rendering layer. Manually exercise the change in a real terminal.

If you're adding a TUI test framework, `ink-testing-library` is the
right choice. Open a PR; we want this.

### Network-dependent tests need a guard

Anything that hits a real API (web_fetch, web_search, OAuth refresh)
needs an `it.skipIf(!process.env.NETWORK_TESTS_ENABLED)` or equivalent —
they can't be in the default `npm test` path because contributors
without API keys would fail their pre-commit.

`src/tools/web-fetch.test.ts` uses a local mock HTTP server. That's the
preferred pattern; only escape to live API if there's no other way.

### Benchmarks don't replace tests

A bench tells you *how fast*. A test tells you *whether correct*. If you
have only a bench, you don't know it's correct. If you have only tests,
you don't know it's fast. The reducer has both for a reason.

## What's worth testing first

When you walk into an unfamiliar module and want confidence:

1. **Pure functions with branchy logic**. `parseAnswer` (plan), `matchOption`
   (plan), `mergeUsage` (reducer helper), `displayPath` (UI), `truncate`,
   `wrapText`, anything with a switch statement.
2. **State machines.** The reducer. The session router. The OAuth state
   transitions.
3. **Parsers and serializers.** `extractJson`, `parseRunArgs`, the message
   stream coalescer.
4. **Filesystem-touching tools.** Read, edit, multi-edit, write, glob, grep.
   Real mkdtemp, real assertions, no mocks.
5. **Permission policies.** Effect matching + path / URL pattern matching.

What's hard to test in this codebase:

- The interactive TUI render output (no harness yet — see above).
- Real-network tools (need either VCR-style fixtures or skip guards).
- Streaming timing (the 16ms coalesce). Can be tested in microbench but
  hard to assert on in unit tests.

## CI

Pre-publish runs `npm run check` automatically (via `prepublishOnly`).
There is no separate GitHub Actions config committed to this repo yet —
the test gate is local. If you're contributing externally, run `npm run check`
before opening a PR; it's the same gate `npm publish` enforces.
