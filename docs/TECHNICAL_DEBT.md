# Technical debt — known parallel implementations of pi-mono

Six items where we re-implemented (or fight) functionality pi-mono already
ships. Surfaced in the 2026-05-14 cross-stack audit. Each item lists
estimated effort, ship-on-main feasibility, and what unblocks it.

## Ship-on-main (no pi-tui dependency)

### 3. OAuth storage — replace ours with pi-mono's AuthStorage
- **Where**: `src/auth/credentials.ts` + `src/auth/token-manager.ts` (~280 LOC)
- **Upstream**: `pi-mono/packages/coding-agent/src/core/auth-storage.ts` (~350 LOC)
- **Why**: pi-mono's version is production-hardened, ships provider-specific
  flows, handles refresh + revocation. We re-derived the basics.
- **Risk**: our `TokenManager` does multi-process single-flight refresh via
  proper-lockfile (the user runs 5–10 instances at once). Verify pi-mono
  handles this — if not, contribute it upstream before swap.
- **Effort**: ~½ day swap, ~1 day if lock contribution needed upstream.

### 4. Session store — adopt pi-mono's SessionManager
- **Where**: `src/sessions/store.ts` (subset of pi-mono's `SessionManager` ~1000 LOC)
- **Upstream**: `pi-mono/packages/coding-agent/src/core/session-manager.ts`
- **What we're missing today**: cwd-validation, fork semantics, conflict
  resolution. If a user moves `~/.codebase`, we drop sessions silently.
- **What stays ours**: the resume CLI flag flow, the per-cwd hashing
  convention. The picker UI (interactive resume chooser) is pi-tui-coupled
  and stays deferred until phase 5.
- **Effort**: ~1 day.

### 5. Model resolution — adopt pi-mono's ModelRegistry
- **Where**: `src/agent/config.ts:110–150`
- **Upstream**: `pi-mono/packages/coding-agent/src/core/model-registry.ts` (~900 LOC)
- **Gains**: provider registration, custom models, fallbacks, thinking-level
  scoping. Drop-in for our `resolveConfig` + `buildProxiedConfig`.
- **Effort**: ~½ day.

### 6. Wire pi-agent-core's tool lifecycle hooks
- **Where**: `src/hooks/manager.ts` + `src/hooks/runner.ts`
- **Upstream**: `pi-agent-core` exports `beforeToolCall` / `afterToolCall`
  in `AgentLoopConfig` (`packages/agent/src/types.ts:47–100`).
- **Today**: our `HookManager` exists but doesn't reach into pi's loop, so
  user hooks can't observe tool calls.
- **Effort**: ~2 hours.

## Pi-tui-blocked (deferred until phase 5)

### 1. Hand-rolled kill ring + undo + paste handling
- **Where**: `src/ui/input-state.ts:1–100`
- **Upstream**: pi-tui's `Editor` ships this natively.
- **Why blocked on pi-tui**: the algorithms are entangled with pi-tui's
  grapheme segmenter, autocomplete provider, and visual layout. Can't
  cleanly lift just the kill-ring without bringing the editor.
- **Effort**: 0 incremental cost — pi-tui migration already covers this.

### 2. Event re-encoding (AgentEvent → Action union)
- **Where**: `src/agent/events.ts:25–80`
- **Why blocked on pi-tui**: the reducer exists because React wants
  immutable state slices. Subscribing to `bundle.subscribe()` directly
  and dropping the `Action` union only pays off in an imperative renderer
  (which pi-tui is). On main with ink, moving the impedance mismatch
  doesn't reduce it.
- **Effort**: 0 incremental cost — pi-tui migration removes the reducer
  by construction.

## Worth keeping (not debt)

These are legitimately ours; pi-mono has no equivalent and we shouldn't
try to upstream them blindly:

- `src/permissions/` — effect-based permissions (~600 LOC). Pi-mono has
  no permission system at all. Contributing upstream would be polite but
  it's not a "remove duplication" task.
- `src/glue/` — small-talk classifier + reply path (~250 LOC). Skips
  agent turns for chit-chat.
- `src/memory/` — episodic memory (~350 LOC). Per-cwd recent decisions.
- `src/plan/` — plan-mode Q&A → review → execute (~200 LOC).
- `src/user-queries/` — modal-overlay primitive (~400 LOC).
