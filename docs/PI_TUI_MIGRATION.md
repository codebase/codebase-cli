# Pi-TUI Migration Plan

Migrating the TUI layer from **ink/React** to **pi-tui** (Mario Zechner's
differential-rendering TUI library that pi-coding-agent uses).

## Why

1. **Scroll-glitch goes away.** ink writes full-frame paints on every coalesced
   render (16ms), and the terminal interprets those as new output → yanks the
   user back to the bottom. pi-tui only redraws changed lines via cursor
   positioning, so the terminal's scrollback stays where the user put it.
2. **~10x lower per-frame CPU.** Real for the user who runs 5-10 codebase
   instances simultaneously — current ink approach has 5-10 React VDOM diffs +
   Yoga layout passes happening in parallel. pi-tui's diff is a line-level
   string compare, vastly cheaper.
3. **Smaller install footprint.** No React + reconciler shipped to npm. Just
   pi-tui's renderer.
4. **Architectural alignment with pi-mono.** Mario's own coding-agent uses
   pi-tui directly. Sitting on his runtime AND his TUI lib is the consistent
   pattern. Lower drift risk over time.
5. **Free features we'd otherwise build.** pi-tui ships:
   - Editor (2292 LOC, vim-mode capable) — replaces our Input's kill ring + undo
   - Markdown — replaces our Markdown.tsx
   - SelectList / SettingsList — replaces our Permission + ModelPicker overlays
   - Keybindings + Autocomplete + Fuzzy matching — replaces our path-complete +
     slash-suggestions logic
   - Loader + Spacer + Box + Text + TruncatedText primitives

## What pi-tui actually is

- **Imperative component model.** Each component implements
  `render(width: number): string[]` and optionally `handleInput?(data: string)`.
- **TUI class extends Container.** `addChild(component)`, focus management,
  overlay system, line-level diff renderer, cursor positioning for IME.
- **Not reactive.** Components have internal state; they invalidate themselves
  to trigger a re-render of the changed lines. No virtual DOM, no fiber tree.
- **Single-package dep:** `@mariozechner/pi-tui` (MIT). About 11,000 LOC of TUI
  primitives.

## Critical decision: keep React, or drop it?

| | Keep React + pi-tui adapter | Drop React, use pi-tui directly |
|---|---|---|
| Effort | High (build the adapter) | High (rewrite UI surface) |
| Permanent complexity | Adapter is a maintenance tax forever | None — uses pi-tui as intended |
| State management | useState / useReducer / useEffect stay | Class state + event emitters / small store |
| Hooks (useCoalescedAgentEvents, usePromptSuggestion) | Keep as-is | Rewrite as event listeners |
| Tests | Mostly unchanged | Cleaner — no react-test-renderer |
| Style alignment with pi-mono | Off-path | On-path |
| Risk | Adapter quirks | Larger initial rewrite |

**Recommendation: drop React.** Pi-mono's own coding-agent does this; building a
React adapter is permanent overhead for no real gain. Our state model is small
(one reducer + a handful of pubsubs) and translates cleanly to event-driven.

## What we're replacing in `src/ui/`

Roughly 3,500 LOC of React+ink code across these files:

| File | LOC | What pi-tui replaces it with |
|---|---:|---|
| `App.tsx` | 450 | Custom pi-tui `Container` subclass orchestrating the rest |
| `Input.tsx` + `input-state.ts` | ~800 | pi-tui `Editor` component (the big single-line/multi-line editor) |
| `Message.tsx` + helpers | ~250 | A custom `Message` component (renders one transcript entry) |
| `MessageList.tsx` | 150 | Container with append-once children; line-diff handles incremental rendering for free |
| `Permission.tsx` | 110 | pi-tui `SelectList` overlay |
| `UserQuery.tsx` | small | pi-tui `Input` overlay |
| `Status.tsx` | 360 | Custom `Status` component (bottom bar) |
| `ToolPanel.tsx` + `TaskPanel.tsx` | small | Custom components |
| `CompactionBanner.tsx` | 30 | Custom component using pi-tui `Loader` |
| `ModelPicker.tsx` | 165 | pi-tui `SelectList` overlay |
| `BackgroundShellPanel.tsx` | 50 | Custom component |
| `FirstRunSetup.tsx` | moderate | pi-tui `SelectList` flow |
| `Welcome.tsx` | moderate | Custom static component |
| `Markdown.tsx` | moderate | pi-tui `Markdown` |
| `Throbber.tsx` | small | pi-tui `Loader` |
| `wrap.ts` | small | Replaced by pi-tui's `visibleWidth` / `sliceByColumn` |
| `path-complete.ts` | moderate | pi-tui `AutocompleteProvider` |
| Misc helpers (`paths.ts`, `tool-labels.ts`, `attachments.ts`, etc.) | — | Kept — framework-agnostic |

## Phasing

Don't do this in one giant rewrite. Stage it.

### Phase 0 — Scaffolding (1 day)
- Add `@mariozechner/pi-tui` dep.
- Create `src/ui-pi/` directory in parallel with `src/ui/`.
- Add `CODEBASE_PI_TUI=1` env flag in `cli.tsx` that dispatches between the two
  render paths. Default off.
- Stand up `src/ui-pi/App.ts` that boots a pi-tui `TUI`, mounts a stub
  `Container`, and exits on Ctrl-C. Verify it runs.

### Phase 1 — Minimum viable shell (2 days)
- Welcome banner component.
- Status bar (just model + state, no live tok/s yet).
- Input row (using pi-tui `Editor` with single-line config) — wire to
  `bundle.agent.prompt()`.
- MessageList: render each finalized assistant/user message as a static line
  block. Drop streaming for now.
- Wire pi-mono's `bundle.subscribe()` events into pi-tui invalidations.
- Output: you can type a prompt, agent responds, response appears. No
  streaming, no tools panel, no overlays.

### Phase 2 — Streaming + tools (2 days)
- Streaming message pane that updates in place. Replace the 16ms coalesce with
  the event-driven model pi-tui prefers.
- Tool execution panel (running/done/error spinner per tool call).
- Permission overlay using pi-tui `SelectList`.
- UserQuery overlay using pi-tui `Input` overlay.

### Phase 3 — Parity features (2 days)
- ModelPicker (pi-tui `SelectList` over the fetched model list).
- BackgroundShellPanel.
- CompactionBanner.
- TaskPanel.
- Live tok/s + ctx % in the status bar.
- Type-ahead queue (translate from React state to component state).
- Mid-turn typing, paste placeholders, ghost text suggestions.

### Phase 4 — Editor depth (1-2 days)
- Multi-line input (`\<Enter>` newline).
- Paste detection + placeholder collapse — pi-tui Editor may already handle
  paste; reuse its hooks if so.
- History recall (↑/↓).
- Slash-command + path-completion via pi-tui `AutocompleteProvider`.
- Kill-ring (Ctrl-K/U/W/Y) — pi-tui Editor likely has this; cross-check before
  building custom.

### Phase 5 — Switch the default + cleanup (1 day)
- Flip `CODEBASE_PI_TUI=1` to default for one release with `CODEBASE_INK_TUI=1`
  available as a backout.
- After one release of soak, delete `src/ui/` entirely. Goodbye React +
  ink. Update `.settings/architecture.md`.
- Drop `react` and `ink` from `package.json`.

**Total: ~9-10 working days for a full migration.**

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pi-tui has rendering quirks ink doesn't (or vice versa) | Soak the flagged path on the maintainer's daily workflow for a week before flipping default |
| State translation introduces subtle bugs (missing subscriptions, race conditions) | Keep both paths until parity is verified by manual testing on common flows |
| Pi-tui's Editor is more opinionated than our hand-rolled Input — some shortcuts might differ | Document any keyboard divergence in CHANGELOG; user testing during phase 4 |
| Pi-tui API churn | Pin exact version in package.json; upgrade deliberately, not on caret |
| 10 days of focused effort is a real opportunity cost | Phase 0-2 give partial value (perf wins on basic flows) even if we never finish phases 3-5 |
| Markdown rendering may differ visually | Visual diff testing during phase 1 |
| Tests need rewriting for non-React components | New test infrastructure: drive components directly, assert `render(width)` output |

## What pi-mono won't give us

- **Plan-mode UI.** Our `runPlanFlow` orchestration is ours, stays ours.
- **Permission policies.** Ours.
- **OAuth + TokenManager.** Ours.
- **Tool registry.** Ours.
- **The agent loop itself.** Already pi-mono's via pi-agent-core; that doesn't
  change.

The migration is purely the **rendering layer** — pi-mono runtime stays.

## Decision points to settle before we start

1. **React stays or goes?** (recommended: goes)
2. **Markdown renderer: pi-tui's or ours?** Pi-tui's is feature-complete and
   would let us drop `diff` + parts of `Markdown.tsx`. Suggested: pi-tui's,
   visually diff during phase 1.
3. **Input editor: pi-tui's Editor or our handrolled Input?** Pi-tui's is
   massive (2292 LOC) but battle-tested. Ours has features we like (paste
   placeholders, ghost text). Suggested: pi-tui's Editor with our paste +
   ghost-text extensions layered on top via its hooks.
4. **Flag name for the dual-path interim?** Suggested: `CODEBASE_PI_TUI=1`.
5. **Soak period before flipping default?** Suggested: 1 week of maintainer
   daily use after phase 4 completes.

## What "done" looks like

- `src/ui-pi/` is the only render path.
- `react` and `ink` are removed from `package.json`.
- No regression on the existing flows: streaming, tools, plan mode, permissions,
  model switching, background shells, mid-turn typing, OAuth refresh during a
  conversation, resume.
- New flows that ink couldn't do well:
  - Scrolling up during streaming actually stays scrolled up.
  - Multiple instances on one laptop don't make the fan spin.

## Estimated impact

- **Source LOC delta:** ~3,500 LOC removed (src/ui/), ~3,000 LOC added
  (src/ui-pi/). Net neutral or slight reduction.
- **Runtime CPU per frame:** roughly 10x lower based on Mario's measured
  numbers (full-frame paint vs line diff).
- **Bundle size:** ~1MB smaller (no React).
- **Test count:** roughly equivalent (different infrastructure, similar
  coverage).
- **User-visible improvements:** scrollback works during streaming, faster
  perceived response, no fan-spin when running multiple instances.

## Not on this branch

This branch is **planning only.** Code changes happen on a separate
implementation branch once the decisions above are settled. The next step is
the user reviewing this doc, settling the open questions, and then we cut
`feat/pi-tui-phase-0`.

---

## Implementation status (as of 2026-05-13)

Decisions settled: React goes, pi-tui renderer + pi-tui's Editor, flag
named `CODEBASE_PI_TUI=1`, one-week soak target. Work landed on
`experiment/pi-tui-migration`. Branch builds clean (`npm run check`) and
all 663 tests pass.

**Phase 0–4 (parity behind the flag): done.**

| Commit | Phase | Surface |
|---|---|---|
| `89ab194` | 0 | Flag dispatch, runtime, stub root container |
| `448d032` | 1 | Welcome banner, status bar, input, transcript, agent wiring |
| `1fd968e` | 2 | Streaming pane, tools, Permission + UserQuery overlays |
| `c1577bf` | 3 | Slash commands, type-ahead queue, bg-shell panel |
| `9b14a9a` | 4a | Editor (multi-line + kill-ring + paste markers), persistent history, `@path` + slash autocomplete, `!cmd` |
| `ff78642` | 4b | Model picker overlay + mid-session model swap |
| `74ba42d` | 4c | ctx% bar, live tok/s, total cost in status bar |
| `3c5b839` | 4d | CompactionBanner + TaskPanel |
| `f8e3986` | 4e | Router-aware submit (chat short-circuit, plan flow) |

### Phase 5 — in progress

Visual + feature parity push so we can flip the default. After this
section the only remaining work is a real-TTY smoke test, the flag
flip, and the ink-path deletion.

| Commit | Surface |
|---|---|
| `0391d48` | Visuals: vertical accent gutter, live tool-call lines + diff summary, throbber, richer welcome |
| (merge) | Pulled v2 audit work (bash validator, hooks, session hardening, file splits) onto the branch |
| `7648897` | bg-shell exit notifier, ErrorCard, ContextWarning (≥85% / urgent ≥95%), submitUserPrompt routing |
| `a6cf288` | **FirstRunWizard** — OAuth / BYOK provider picker / key entry / error recovery |

### Still not ported (small / optional)

- **`ToolPanel.tsx`** — separate sticky panel of in-flight tools. The
  pi-tui path already renders running tools inline under the streaming
  message with the same spinner + label, so this is largely
  redundant. Skipping unless the user calls it out.
- **`PixelC.tsx`** — ASCII-art logo in welcome. Decorative; the cyan
  wordmark works.
- **Suggestion ghost-text** (`usePromptSuggestion`) — pi-tui Editor
  doesn't expose a ghost-text hook. Either upstream contribution or
  accept the regression.
- **Debug-input logging** — `CODEBASE_DEBUG_INPUT=1` doesn't currently
  wire on the pi-tui path. Low priority; pi-tui's own keybinding
  manager is the right surface to add this to.

### Remaining for phase 5 completion

1. **Real-TTY smoke test.** `CODEBASE_PI_TUI=1 codebase` in iTerm /
   Terminal.app / GNOME Terminal. Exercise: chat, tool calls, slash
   commands, model picker, @path, !cmd, history recall, Ctrl-C abort,
   Ctrl-C twice exit, plan mode.
2. **Flag flip.** Make pi-tui the default in `src/cli.tsx`; keep
   `CODEBASE_INK_TUI=1` as the backout for one release cycle.
3. **Ink deletion.** Once one release ships without rollback reports,
   delete `src/ui/` (keeping the pure helpers that pi-tui borrows:
   `attachments.ts`, `history-store.ts`, `paths.ts`, `tool-labels.ts`,
   `shell-escape.ts`) and drop `react` + `ink` + react-related
   @types from `package.json`.
