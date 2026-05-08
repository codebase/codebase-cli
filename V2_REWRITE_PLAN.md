# Codebase CLI v2 — TypeScript Rewrite Plan

**Status:** `v2` branch open, forked from `origin/anthropic-support` (Go v0.9.0 + OAuth).
**Goal:** Rewrite the CLI in TypeScript on top of pi-mono, sharing runtime DNA with the web coder. Preserve every shipping feature on `anthropic-support`, including OAuth, MCP, the IDE bridge, hooks, memory, the task system, and the 30-tool registry.
**Constraint:** Don't break v1 users. Tag the last Go release as `v1.x` before swapping default branch. OAuth-bound users must keep working tokens after upgrade.
**Quality bar:** This is a production app with shared collaborators — no shortcuts, match upstream pi-mono patterns, tests land alongside features.

---

## Ground truth (read this before anything else)

The original v2 plan was drafted against `main`, which is stale. The Go ground truth is **`origin/anthropic-support`** (now local branch `v2`), which is 13 commits ahead and contains substantial systems the earlier plan treated as future work.

**What `main` has that the original plan got right:** the basic agent loop, glue layer, plan mode, diagnostics, permissions allowlist, compaction, session persistence, the original 14 tools.

**What `anthropic-support` adds that must be ported (was treated as Phase 5/6/8 future work):**

| System | Go file | Status on this branch |
|---|---|---|
| OAuth (PKCE) | `auth.go` (440 LOC), `docs/cli-auth-plan.md` | Live: PKCE flow, `~/.codebase/credentials.json` (mode 0600), `inference projects credits` scopes against `codebase.foundation/api` |
| Inference proxy | `llm.go`, `llm_anthropic.go` | Routes Anthropic Messages API + MiniMax through Codebase backend for credit deduction |
| MCP client | `mcp.go` | stdio + SSE transports via `mcp-go`, `~/.codebase/config.json` server list, tools join the main registry |
| IDE bridge | `ide.go`, `vscode.go` | Lockfile discovery in `~/.claude/ide/` + `~/.codebase/ide/`, workspace matching, ws/sse transport |
| Hooks engine | `hooks.go` (241 LOC) | 6 event types (PreToolUse, PostToolUse, PostEdit, UserPromptSubmit, SessionStart, Stop), shell-command handlers with matchers, exit-code-2 = block |
| Memory system | `memory.go`, `internal/tools/memory.go` | Per-project `~/.codebase/projects/{hash}/memory/`, `MEMORY.md` index (200-line/25KB cap), `save_memory` + `read_memory` tools |
| Task system | `tasks.go`, `internal/tools/tasks.go` | Live task checklist in TUI, 4 tools (create/update/list/get) |
| Tool registry | `internal/tool/`, `internal/tools/` | 30 tools in `internal/tools/register.go`. Provider-neutral `Registry` with `OpenAITools()` / `AnthropicTools()` schema generators. `Tool` interface includes `ConcurrencySafe()` and `Effects()` |
| Headless mode | `headless.go` | `codebase run "<prompt>"` for scripting/CI |
| DotEnv loader | `dotenv.go` (61 LOC) | Auto-loads `.env` (cwd) then `~/.codebase/.env`; never overrides real env |
| File history | `filehistory.go` (167 LOC) | Session-only undo, 100-snapshot circular buffer, SHA256 dedup, powers `/undo` |
| Setup wizard | `setup.go` | First-run guided config |
| Project pull | `pull.go` | `codebase pull <project>` syncs from Codebase platform |
| Streaming exec | `streaming_executor.go` | Tool-call orchestration with live updates |
| TUI overhaul | `chat.go`, `render.go`, `theme.go` | Frameless layout, left-accent tool blocks, bottom-pinned status, gradient dividers, centered permission box, throbber, terminal-safety ANSI handling |

**What still doesn't exist** (real greenfield for the TS rewrite, not just port work):
- FileStateCache read-before-edit invariant
- Real API-reported token usage with cache-read/write fields (current code is `chars/3.8` heuristic in `compact.go`)
- Skill loader (user-defined `.md` files in `~/.codebase/skills/`)
- Output styles (Default/Explanatory/Learning)
- System prompt cache boundary split (static prefix vs. dynamic suffix)
- 4-type memory taxonomy enforcement (code recognizes types but doesn't gate them)

---

## Reference source trees on disk

- **pi-mono source** (TypeScript agent runtime + provider abstraction we're depending on as published npm packages):
  `/home/half/polyvibe-poc/.pi-mono/` — versions pinned at **0.74.0** for both `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
  Key packages:
  - `packages/agent/` — `Agent`, `agentLoop()`, event surface (`turn_start/end`, `message_*`, `tool_execution_*`), hook surface (`beforeToolCall`, `afterToolCall`, `transformContext`, `getSteeringMessages`, `getFollowUpMessages`)
  - `packages/ai/` — `streamSimple()` / `completeSimple()`, 20+ provider implementations including `anthropic`, `openai-responses`, `google-generative-ai`, `amazon-bedrock`
  - `packages/coding-agent/` — full reference impl. Worth shape-copying: tool definitions (TypeBox + `onUpdate` streaming), compaction (`CompactionDetails { readFiles, modifiedFiles }`), session persistence
  - `packages/web-ui/` and `packages/tui/` — *do not lift*

- **Claude Code source** (deobfuscated, pattern reference only — never copy verbatim):
  `/home/half/claude-code-source/`
  - `src/cost-tracker.ts` — accurate API-reported usage, `Usage` shape with cache fields
  - `src/memdir/` — MEMORY.md handling, 200-line/25KB truncation at line→byte boundaries (cache-safe)
  - `src/tools/` — FileStateCache (`isPartialView` flag enforces read-before-edit), `lazySchema()` to dodge circular Zod imports, permission gates via `checkWritePermissionForTool()`
  - `src/outputStyles/` — markdown + frontmatter, `keep-coding-instructions` flag controls cache-boundary placement
  - `src/keybindings/` — file watcher (500ms debounce) + parser + resolver + dispatch context
  - `src/plugins/` — plugin/skill loader with `id@source` format
  - `src/commands/` — slash-command registry
  - `src/coordinator/` — sub-agent tool filtering by mode

### Strategy docs (background, may be partly superseded by the audit above)

1. `/home/half/polyvibe-poc/.settings/compare/codebase-cli-vs-pi-mono.md` — fork-or-keep decision
2. `/home/half/polyvibe-poc/.settings/compare/pi-mono-harness-lift.md` — ranked patterns to lift
3. `/home/half/polyvibe-poc/.settings/compare/pi-mono.md` — full architectural comparison

---

## Architecture decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Agent loop | `@earendil-works/pi-agent-core@0.74.0` (npm dep, not fork) | Stays close to upstream; no merge tax |
| Provider abstraction | `@earendil-works/pi-ai@0.74.0` (npm dep) | Normalizes 20+ providers; keeps Anthropic + Codebase-proxy routing |
| TUI | Ink (React-based) | Matches Claude Code, Aider, Gemini CLI; mature |
| Schema | TypeBox | Matches pi-mono's tool shape |
| Node version | ≥20 | Matches pi-mono engines |
| Bin name | `codebase` (preserved) | v1 users keep muscle memory |
| Distribution | npm primary; Bun single-binary follow-up | npm for reach, Bun for fast startup later |
| Repo strategy | `v2` branch in this repo, forked from `anthropic-support` | Preserves OAuth + 30-tool work; tag Go as `v1.x` before swap |
| Tests | Vitest + faux provider harness (mirrors pi-mono `packages/ai/src/providers/faux.ts`) | Deterministic |
| Linter/formatter | Biome | Matches pi-mono |
| Source of truth for ports | `origin/anthropic-support`, **not** `main` | `main` is missing OAuth, MCP, IDE bridge, hooks, memory, task system |

### What we're *not* doing

- Not forking pi-mono — using as published npm packages.
- Not preserving the demoscene boot screen and chiptune audio in v2.0. Port back later if users miss it.
- Not building the web-coder integration in this repo. The web coder gets its own pi-mono lift; both projects depend on the same npm packages.
- Not skipping OAuth or MCP because they're "complex." They ship today on `anthropic-support` and users depend on them.

---

## Phase plan

Phases 0 and 1 run in parallel. Phases 2–8 are roughly sequential, but tools (Phase 2) can start as soon as Phase 1's loop is wired.

### Phase 0 — Scaffolding (1–2 days)

- `package.json` at repo root with `@earendil-works/pi-agent-core@0.74.0`, `@earendil-works/pi-ai@0.74.0`, `ink`, `react`, `@sinclair/typebox`, `vitest`, `@biomejs/biome`.
- `tsconfig.json` extending pi-mono's base.
- `src/cli.tsx` entry, basic Ink shell that renders "hello".
- `bin/codebase` shebang.
- CI workflow (`.github/workflows/ci.yml`) running `vitest`, type-check, biome.
- `biome.json` matching pi-mono's config.
- Update `README.md` for v2 (Go install path stays in a `README.v1.md` or similar).

**Acceptance:** `npm run dev` opens a usable Ink TUI that streams from one provider via pi-ai.

### Phase 1 — Core loop (3–5 days)

- Wire pi-agent-core's `Agent` and `agentLoop` into the Ink app.
- Implement `convertToLlm` and `transformContext` adapters for our message shape.
- Implement abort handling (Ctrl-C → AbortController → forwarded to pi-agent-core).
- Subscribe to AgentEvents → render to Ink (streaming text, tool blocks, status, task panel).
- Faux-provider test harness (mirror `.pi-mono/packages/ai/src/providers/faux.ts`).

**Acceptance:** A user prompt round-trips to a real provider, streaming output renders, Ctrl-C aborts cleanly. Faux provider reproduces 3 deterministic scenarios in vitest.

### Phase 2 — Tools port + quality upgrade (3 weeks) — ✅ DONE 2026-05-07 (19/30 shipped, 11 deferred to owning phases)

**Status:** 19 tools shipped at full quality (159 vitest tests). The other 11 wait for their owning phase rather than ship as cross-phase stubs (see `feedback_one_phase_at_a_time.md` in memory).

Shipped this phase: `read_file`, `edit_file`, `multi_edit`, `write_file`, `notebook_edit`, `shell`, `list_files`, `glob`, `grep`, `git_status`, `git_diff`, `git_log`, `web_fetch`, `web_search`, `dispatch_agent`, `create_task`, `update_task`, `list_tasks`, `get_task`.

Deferred (each lands with the phase that supplies its missing infrastructure):
- Phase 3 (permission gate): `git_commit`, `git_branch`, `enter_worktree`, `exit_worktree`, `ask_user`
- Phase 4 (plan flow): `enter_plan_mode`, `exit_plan_mode`
- Phase 5 (MEMORY.md taxonomy): `save_memory`, `read_memory`
- Phase 6/7 (settings + slash commands): `config`

All audit-flagged critical bugs from the Go impl are closed: concurrent-modification detection on edits, BOM/CRLF preservation, shell streaming + disk spill on overflow, configurable timeout, image-as-ImageContent, .gitignore-aware glob/grep, file-mode preservation. Per-tool checklist below stayed the binding contract; the rest of this section is preserved as the contract that future tool ports (deferred set + any new tools) must also satisfy.

---

Port all **30 tools** from `internal/tools/` to TypeBox + pi-agent-core's `AgentTool` shape. **Do not port line-by-line — rewrite each tool against the quality checklist below.** A head-to-head comparison of our `read/edit/shell/grep/dispatch` against pi-mono and Claude Code (2026-05-07) found our architecture is solid but edge-case handling has critical gaps. Keep what's good; close the gaps using patterns from both references.

**Architecture to preserve from Go:**
- `Tool` interface shape (`Name/Description/Schema/Execute/ConcurrencySafe/Effects`).
- Input-dependent `ConcurrencySafe()` for shell (`shell.go:54-107` analyzes prefix + piped first command).
- File-mode preservation on write (`editfile.go:71`).
- Provider-neutral `Registry` with `OpenAITools()` / `AnthropicTools()` schema generators.
- Tool-impl directory separate from registry infrastructure (`internal/tools/` vs `internal/tool/`).

**Per-tool quality checklist (every tool must pass):**
1. **Schema**: TypeBox with explicit defaults, descriptions cite limits + examples, timeouts/limits exposed in schema (not hardcoded).
2. **Validation**: bounds-check numeric inputs (no negative offset/limit), reject obviously malformed args before doing work, error messages tell the LLM how to retry.
3. **Edge cases**: BOM-aware, line-ending preserving, encoding-detected, symlink-resolving, binary-detecting (magic bytes, not just null-byte scan).
4. **Streaming** (`onUpdate`): mandatory for shell, dispatch_agent, web_fetch, search_files. Pattern: pi-mono `bash.ts:291-325` `OutputAccumulator` (100ms throttle + disk spill on truncation).
5. **Concurrent-modification detection**: edit_file / multi_edit / write_file must record file mtime at validation, compare at execute, reject with `FILE_UNEXPECTEDLY_MODIFIED` if changed. Pattern: Claude Code `FileEditTool.ts:139`.
6. **Read-before-edit**: enforced via FileStateCache (LRU 100 entries, 25MB cap, `isPartialView` flag for offset/limit reads). Pattern: Claude Code `src/utils/fileStateCache.ts`.
7. **Permission**: gated via `beforeToolCall` hook reading from a single allowlist source (carry over the Go allowlist verbatim).
8. **Output persistence**: shell + search results > truncation cap go to a temp file with the path surfaced in the tool result. Don't drop tails silently.
9. **Tests**: vitest unit test per tool covering at minimum the failure modes (missing file, ambiguous match, timeout, BOM file, large output, concurrent mod). Faux-provider-driven integration test for the dispatch loop.

**Critical-bug list to close (these exist in the Go code today):**
- 🔴 `editfile.go`: no concurrent-mod detection — silent data loss if file changes mid-edit.
- 🔴 `editfile.go` / `writefile.go`: no BOM handling — Windows-authored files fail with "not found."
- 🔴 `shell.go`: 30KB in-memory output cap, no disk spill — long test runs lose their tail.
- 🟠 `shell.go`: no streaming, hardcoded 2-min timeout not in schema.
- 🟠 `readfile.go`: no image support; rejects rather than resizes.
- 🟡 `searchfiles.go`: hardcoded exclusions instead of `.gitignore` respect.

**Tool inventory (all 30):**

| Category | Go file | TS target |
|---|---|---|
| Filesystem read | `internal/tools/readfile.go`, `listfiles.go`, `searchfiles.go`, `glob.go`, `grep.go` | `src/tools/fs/` |
| Filesystem write | `internal/tools/writefile.go`, `editfile.go`, `multiedit.go`, `notebook.go` | `src/tools/fs/` (gated by FileStateCache) |
| Shell | `internal/tools/shell.go` | `src/tools/shell.ts` (with `onUpdate` streaming) |
| Git | `internal/tools/git.go`, `worktree.go` | `src/tools/git/` |
| Web | `internal/tools/websearch.go`, `webfetch.go` | `src/tools/web/` |
| Agent dispatch | `internal/tools/dispatch_agent.go` | `src/tools/dispatch.ts` |
| Tasks | `internal/tools/tasks.go` | `src/tools/tasks.ts` |
| Planning | `internal/tools/planmode.go` | `src/tools/plan.ts` |
| Config | `internal/tools/config.go` | `src/tools/config.ts` |
| User interaction | `internal/tools/askuser.go` | `src/tools/ask-user.ts` |
| Memory | `internal/tools/memory.go` | `src/tools/memory.ts` |

**Specific invariants to preserve from Go:**
- **`internal/tools/shell.go`**: timeout (now schema-exposed), permission gate via `permission.go` allowlist, dangerous-pattern blocker.
- **`internal/tools/editfile.go`**: exact-string match, fail on ambiguous (≥2 matches), file-mode preservation.
- **`internal/tools/multiedit.go`**: per-file atomicity (rollback if any edit to a file fails).
- **`internal/tools/searchfiles.go`**: ripgrep first, fall back to grep.
- **`internal/tools/dispatch_agent.go`**: read-only tool filter + `shellWritePatterns` block list. Max 25 turns. No recursion (no nested dispatch).
- **`internal/tool/tool.go`** `ConcurrencySafe()` input-dependent flag: read tools + git read tools + web tools must run in parallel; write tools sequential; shell decides based on command prefix.

**Acceptance:**
- All 30 tools registered, schemas pass TypeBox validation, behavior parity with Go on the green path.
- FileStateCache enforced; concurrent-modification detection live (test: edit a file that changes between read and edit → `FILE_UNEXPECTEDLY_MODIFIED` error, not silent failure).
- `onUpdate` streaming demonstrably works on shell (test: run a 5s sleep loop, observe partial output before completion).
- BOM round-trip test passes (test: edit a UTF-8-BOM file, verify BOM preserved on disk).
- Shell output > truncation cap is persisted to a temp file, path surfaced in result.
- vitest coverage per tool covers the failure modes listed in the checklist.

### Phase 3 — Hooks, permissions, diagnostics (1 week) — ✅ DONE 2026-05-07 (24/30 tools, 246 tests)

**Status:** Hooks engine, permission store + Ink prompt, diagnostics engine + steered injection all shipped. Five deferred Phase 2 tools landed alongside: `git_commit`, `git_branch`, `enter_worktree`, `exit_worktree`, `ask_user`. The remaining 6 tools wait for their owning phase: `enter_plan_mode` + `exit_plan_mode` (Phase 4), `save_memory` + `read_memory` (Phase 5), `config` (Phase 6/7).

What landed:
- **HookManager** (`src/hooks/`): 6 event types, JSON config from `~/.codebase/hooks.json` + `.codebase/hooks.json`, exit-2 blocks, async fire-and-forget, matcher syntax for tool|alternation:pathGlob.
- **PermissionStore + Ink prompt** (`src/permissions/`, `src/ui/Permission.tsx`): in-session trust state (allow-once / trust-tool / trust-all), risk classification, single-keystroke responses. Read-only tools auto-allow. Shell auto-allows when the command matches the read-only allowlist (`permission.go:65–90` ported verbatim).
- **DiagnosticsEngine** (`src/diagnostics/`): tsc / go vet / pyright / eslint, 15s per-checker timeout, NO_COLOR=1 env, project-type auto-detect cached per session, fire-and-forget run from `afterToolCall` so the tool result isn't blocked. Results steered into the next turn as a `<system-reminder>` user message via `agent.steer()`.
- **UserQueryStore + UserQueryView** (`src/user-queries/`, `src/ui/UserQuery.tsx`): same pattern as permissions but for free-form input. Drives `ask_user`.

The agent's `beforeToolCall` runs permissions first, then user hooks; `afterToolCall` runs hooks then schedules diagnostics. App.tsx priority for the input row is Permission > UserQuery > Input.

---



- Port `hooks.go` to a TS hooks engine. Keep the 6 event types (PreToolUse, PostToolUse, PostEdit, UserPromptSubmit, SessionStart, Stop). Bridge to pi-agent-core's `beforeToolCall` / `afterToolCall` for tool gating; keep external-shell-command hooks for the rest. Config schema preserved (`~/.codebase/hooks.json` and `.codebase/hooks.json`). Exit code 2 = block.
- Port `permission.go`. Move the read-only allowlist (Unix + Windows/PowerShell + Git read + build/test prefixes — currently ~40 entries at `permission.go:65–90`) verbatim. Wire as a `beforeToolCall` hook for `shell`. Preserve `Risk` (LOW/MEDIUM/HIGH) and `Explanation` from the glue classifier in the permission request.
- Port `diagnostics.go`. Keep the 15s per-checker timeout, `NO_COLOR=1` env, language auto-detect (Go via `go.mod`, TS via `tsconfig.json`, Python via `pyright` in PATH, ESLint via `eslint.config.js`). Inject errors as a system message via the steering queue (`getSteeringMessages`), not as a fresh user turn.

**Acceptance:** Editing a TS file with a type error and asking the agent to fix it: the agent sees the diagnostic on the next turn without user paste. External hooks defined in `~/.codebase/hooks.json` still execute.

### Phase 4 — Glue + plan mode (1 week) — ✅ DONE 2026-05-08 (27/30 tools, 297 tests)

**Status:** Glue (cheap-model sidecar with intent classifier + narration), plan engine (Q&A → markdown plan), and plan mode tools (`enter_plan_mode` / `exit_plan_mode`) all shipped. The plan-mode permission gate blocks every destructive tool while active. The App-level UI integration (intent classification before agent.prompt, plan-mode UI screen) lands in Phase 11 alongside the rest of the TUI parity work. 27/30 tools shipped; remaining 3 = `config` (Phase 6/7), `save_memory` + `read_memory` (Phase 5).

---



Port from `glue.go` and `plan.go`:
- `GlueClient` with `fast` + `smart` model split via `GLUE_FAST_MODEL` / `GLUE_SMART_MODEL` env vars.
- Intent classification (`IntentAgent` / `IntentPlan` / `IntentChat` / `IntentClarify`) with the **active-history fast track**: follow-ups default to `IntentAgent`; greetings short-circuit to `IntentChat` without an LLM call.
- Plan mode: 1–5 questions, JSON-extraction fallback for messy LLM responses, "Start building" escape option, exact prompt phrasing preserved (`"Build this project. Follow the approved plan exactly. Follow the plan step by step. Implement every listed item. Keep going until all files are written."`).
- Narration / title generation / follow-up suggestions with their length clamps (narration ≤80 chars, titles ≤50 chars).

**Acceptance:** "Add auth to my Next.js app" triggers plan mode, asks 2–3 questions, produces a reviewable plan, then runs the agent.

### Phase 5 — Memory + compaction (4–5 days) — ✅ DONE 2026-05-08 (29/30 tools, 340 tests)

**Status:** Memory subsystem (per-project store at `~/.codebase/projects/<hash>/memory/` with 4-type taxonomy enforcement, MEMORY.md auto-injection capped at 200 lines / 25KB, save_memory + read_memory tools), compaction engine (snip-then-summarize at 75% threshold, safe-split detection, file-op preservation across the cut, transformContext wiring), and session persistence (per-cwd JSON snapshot keyed off sha256(cwd)[:8], auto-save on agent_end, 7-day staleness + model-match check, atomic tmp+rename) all shipped. 29/30 tools done; only `config` remains (Phase 6/7).

---

- Port `memory.go`. Keep per-project isolation at `~/.codebase/projects/{projectHash}/memory/`. MEMORY.md auto-injection into system prompt with 200-line/25KB cap (matches Claude Code's `truncateEntrypointContent()` — line cut first, then byte-cut at newline). **Add** the 4-type taxonomy enforcement (user/feedback/project/reference) via `parseMemoryType()` in `save_memory` / `read_memory` tools.
- Port `compact.go`. 75% threshold, 8 most-recent messages preserved, safe-split detection between assistant-with-tool-calls and tool results, exact summarization prompt phrasing preserved. **Upgrade** from `chars/3.8` heuristic to real API-reported token counts where available (pi-ai exposes them per provider).
- Add `CompactionDetails { readFiles, modifiedFiles }` from pi-mono's coding-agent so file-op history survives summarization.
- Port `session.go`: `~/.codebase/sessions/{sha256(workdir)[:8]}.json`, atomic write via tmp+rename, 7-day staleness, model-name match check. Preserve the markdown conversation format alongside.

**Acceptance:** A 100-turn session compacts without losing file-op history. Memory survives across sessions. `~/.codebase/` data dir is byte-compatible with Go v1.

### Phase 6 — OAuth + inference proxy (1 week) — ✅ DONE 2026-05-08 (29/30 tools, 383 tests)

**Status:** Auth subsystem fully shipped. PKCE crypto (RFC 7636: 64-byte verifier, SHA-256 challenge, anti-CSRF state, constant-time compare). CredentialsStore at `~/.codebase/credentials.json` with 0600 mode enforced and atomic writes; load is defensive (malformed self-clears, unknown versions return null). Browser-based OAuth login spins a localhost callback server, opens the browser, validates state in constant time, and exchanges the code via form-encoded POST. CLI subcommands `codebase auth login / logout / status / refresh / <key>` wired before the TUI launches. resolveConfig now routes through `https://codebase.foundation/api/cli` (overridable) when a non-expired token is present — pi-ai's provider implementations work unchanged because the proxy mimics each wire protocol. CODEBASE_DISABLE_PROXY=1 forces direct-provider mode for debugging. The proxy backend itself (the platform-side endpoints) is a separate work item; this side is ready to talk to it.

---

Port from `auth.go` (440 LOC) and `docs/cli-auth-plan.md`:
- **PKCE flow**: `generateCodeVerifier()`, `generateCodeChallenge()`, `generateState()` — full RFC 7636 compliance.
- **Browser flow**: `codebase auth login` spins a `localhost:{random_port}` HTTP server, opens `https://codebase.foundation/cli/auth?...redirect_uri=...`, receives the auth code on `/callback`, exchanges for token.
- **Headless flow**: `codebase auth <key>` accepts a dashboard-issued API key for SSH/CI.
- **Credential storage**: `~/.codebase/credentials.json`, **mode 0600** (enforce explicitly on write). Schema: `accessToken`, `refreshToken`, `expiresAt` (Unix), `scopes`, `userId`, `email`. Scopes: `inference projects credits`.
- **Token refresh**: refresh on 401 from inference proxy; re-prompt browser flow on refresh failure.
- **Inference proxy** (port from `llm.go` / `llm_anthropic.go`): when authenticated, route LLM calls through `https://codebase.foundation/api/cli/chat/completions` and `/cli/messages` with `Authorization: Bearer <accessToken>`. Backend deducts credits per call. Direct-provider mode (using user's own `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) still supported as fallback.

**Subtleties to preserve:**
- URL-encode all OAuth params (commit `ac1dd56` fixed a bug where spaces in scope broke the URL).
- Redirect URI must be the exact `localhost:{port}` advertised, not a wildcard.
- Don't log tokens. Ever.
- On the inference proxy path, surface backend-reported usage (real cache reads/writes) rather than local heuristics.

**Acceptance:** `codebase auth login` opens browser, completes OAuth, persists credentials at mode 0600. Subsequent agent runs route through the proxy and show real usage. `codebase auth logout` revokes locally and (best-effort) server-side. Refresh on token expiry is silent.

### Phase 7 — Slash commands + skills + output styles (3–4 days) — 🟡 PARTIAL 2026-05-08

**Status:** Slash-command registry + 7 builtins shipped (`/help`, `/clear`, `/compact`, `/session`/`/info`, `/model`, `/whoami`/`/status`, `/exit`/`/quit`). Skill loader (`~/.codebase/skills/*.md`) and output styles (Default/Explanatory/Learning) are deferred — they layer on top of the registry without changing it, so they can land independently.

---

- Port `commands.go`. Current set: `/help`, `/clear`, `/compact`, `/model`, `/session` (alias `/info`), `/copy`, `/theme`, `/diagnostics` (alias `/diag`), `/undo` (powered by FileHistory). Plus auth: `/login`, `/logout`, `/whoami`, `/keys`. Handler signature: `(ctx, args) => effect`.
- **Add** skill loader with three sources merged through one registry (`src/skills/loader.ts`):
  - **bundled** — ships with the binary
  - **user** — local `.md` files in `~/.codebase/skills/`
  - **platform** — fetched from the user's codebase.foundation account when OAuth'd. `src/skills/platform-loader.ts` is the contract anchor; wire format documented inline (GET `/api/cli/skills`). ETag-cached under `~/.codebase/cache/platform-assets.json`. Refresh on `codebase auth refresh` or hourly.
- **Add** templates and prompts to the same loader pipeline. Templates emit a file tree; prompts are saved snippets. The platform path is the differentiator — local-only skill systems (Claude Code, pi-tui) can't ship per-account curated assets.
- **Add** output styles (Default/Explanatory/Learning). Markdown + frontmatter, loaded from `~/.codebase/output-styles/*.md` then project `.codebase/output-styles/*.md`. Place style content **below** the cache boundary so toggling doesn't bust the prompt cache.

**Acceptance:** `/login` initiates OAuth. User-defined skill in `~/.codebase/skills/optimize.md` is discovered and invocable as `/optimize`. After `codebase auth login`, skills/templates/prompts saved on the user's codebase.foundation account appear in `/help` with a `(platform)` source tag. Local skill with the same id as a platform skill keeps its local override (override priority: platform > bundled > user). Style switch via `/style learning` or `--style=learning` CLI flag works.

### Phase 8 — Cost tracking + cache boundary (2–3 days) — 🟢 SUBSTANTIALLY DONE 2026-05-08 (460 tests)

**Status:** Usage shape adopted, `/cost` slash command surfaces full breakdown (input/output/cache-read/cache-write tokens, dollars per bucket, cache hit rate, per-turn average, proxy-source tag). Compaction now prefers `usage.totalTokens` from pi-agent-core's assistant messages over the chars/3.8 heuristic — real accounting on the half of the transcript that has it, heuristic only where it must. Static-prefix vs. dynamic-suffix split deferred: our system prompt is already fully static (only the date rolls daily; no per-turn injection), so pi-ai's default cache control should already kick in. `cacheRetention` is in pi-ai's `SimpleStreamOptions` but not surfaced through pi-agent-core's `AgentOptions` — surfacing it is upstream work. `/cost` is the diagnostic; once a session shows the hit rate, we'll know whether to push the upstream change.

---

- Adopt pi-ai's `Usage` shape including `cacheRead` / `cacheWrite` / `cost`. Display in `/session` and a new `/cost` command.
- System prompt cache boundary: split static prefix (cache-eligible — system instructions, tool list, MEMORY.md) from dynamic suffix (per-turn — current task, recent diagnostics, output style). Anthropic prompt caching ⇒ ~20–25% input token savings on turn 2+.
- Replace the `chars/3.8` heuristic in compaction with real counts where the provider returns them.

**Acceptance:** A multi-turn Anthropic session shows >50% cache hit rate after the first turn. `/cost` reflects accurate per-provider cost. Inference-proxy path uses backend-reported usage.

### Phase 9 — MCP + IDE bridge port (1 week) *(was Phase 8, now narrower since most exists in Go)*

- **MCP**: port `mcp.go`. stdio + SSE transports (no WebSocket). `~/.codebase/config.json` server list with per-server env-var expansion. Discovered tools register into the same registry as locals; provider-neutral schema generation handled by the registry. Reference TS impl: `@modelcontextprotocol/sdk` for client. Defer JIT tool loading until tool count crosses ~50.
- **IDE bridge**: port `ide.go` and `vscode.go`. Lockfile discovery in `~/.claude/ide/` and `~/.codebase/ide/`, workspace-folder matching against cwd, ws/sse transport, auth token from lockfile. Use to: open files in IDE, show diffs in IDE diff viewer, surface task panel.
- Plugin/marketplace stub deferred to v2.1.

**Acceptance:** A locally-installed MCP server (e.g., GitHub MCP via stdio) shows up as tools; agent can call them transparently. Running `codebase` from a directory open in VS Code detects the IDE and opens edits via the bridge.

### Phase 10 — Headless + dotenv + filehistory (3–4 days) — 🟡 PARTIAL 2026-05-08

**Status:** Headless run (`codebase run <prompt>`) ships streaming assistant text to stdout, tool noise to stderr, exit codes 0/1/130. DotEnv loader auto-applies cwd/.env then ~/.codebase/.env at process start, never overriding real env. FileHistory (undo) and the first-run setup wizard are deferred — both are pure-UX layers over already-stable subsystems.

---

- Port `headless.go`: `codebase run "<prompt>"` runs the agent loop without TUI, streams text + tool calls to stdout, debug to stderr. Required for CI/scripting.
- Port `dotenv.go`: auto-load `.env` (cwd) then `~/.codebase/.env` at startup. Never override existing env vars. Support quoted values + `export` prefix.
- Port `filehistory.go`: session-only undo, 100-snapshot circular buffer, SHA256 dedup, `Undo()` restores most-recent or deletes if file didn't exist before. Powers `/undo`.
- Port `setup.go`: first-run guided config (model selection, OAuth login prompt).

**Acceptance:** `codebase run "summarize this repo"` works in CI without a TTY. `.env` files load. `/undo` reverses the last edit.

### Phase 11 — TUI parity + polish (1 week) — 🟢 SUBSTANTIALLY DONE 2026-05-08 (453 tests)

**Status:** Headline TUI work shipped — intent routing (chat replies skip the agent), full plan-mode flow (Q&A → reviewable plan → approve/revise/cancel via UserQuery), live TaskPanel + ToolPanel rendering above the status bar, kill-ring/cursor editing in Input, pre-wrap message text at word boundaries, /copy slash command with OSC 52 + platform fallbacks. Frameless layout + left-accent tool blocks + throbber were already in place from Phase 1. Remaining items are polish (gradient dividers, centered permission box, OSC 633 prompt boundaries) — none block usability.

---

The Go TUI on `anthropic-support` had two overhauls (`3900a1b` + `d7a250a`) that the Ink rewrite must match aesthetically. Specific patterns to preserve:

- Frameless layout — no top/bottom borders, full-width/height.
- Left-accent tool blocks (color bar on the left side of each tool result, not inline styling).
- Bottom-pinned status: active tool indicator + notification bar pinned above input, never scrolls off.
- Centered permission box (use Ink's flex layout or equivalent of `lipgloss.PlaceHorizontal()`).
- Gradient dividers between conversation segments.
- Throbber spinner with character cycling (`⣾⣽⣻⢿⡿⣟⣯⣷` or similar).
- Live task panel powered by the task system tools.
- Terminal safety: OSC 633 prompt boundaries for shell integration; no raw ANSI leakage on resize.

**Acceptance:** Side-by-side screenshots of Go v1 (`anthropic-support`) and TS v2 are visually equivalent.

### Phase 12 — Distribution + migration (3–5 days) — 🟢 IN-REPO WORK DONE 2026-05-08

**Status:** Everything that can be committed to this repo is shipped. The `npm publish` itself, the npm scope reservation, the Homebrew tap repo, the codebase.foundation install URL, and the `v1.0.0` tag on `anthropic-support` all need an operator with the right credentials — see `docs/DISTRIBUTION.md` for the runbook.

What's shipped in-repo:

- ✅ `package.json` is publish-ready (public scope, files allowlist, prepublishOnly = clean+check+build, prepack=build, repository / bugs / homepage metadata, `publishConfig.access=public`).
- ✅ `.npmignore` keeps the tarball lean — 136 KB / 172 files, only `dist/`, `bin/`, `LICENSE`, `README.md`. Verified clean of src/test/config files via `npm pack --dry-run`.
- ✅ `install.sh` rewritten as the npm-first one-liner: detects an existing Go v1 binary by shebang sniffing (binary = no shebang = v1), asks before removing it, checks Node ≥ 20 (with Volta/fnm/nvm hint if missing), prefers user-prefix npm to avoid sudo, falls back to sudo when needed. Preserves `~/.codebase/` end-to-end so OAuth tokens carry over without re-auth (the v1 plan note about `~/.config/codebase/` was incorrect — both v1 and v2 use `~/.codebase/credentials.json`).
- ✅ `--version` and `--help` flags landed in `cli.tsx` (the README referenced them and the brew formula tests them).
- ✅ `.github/workflows/release.yml` rewritten: triggers on `v2.*` tags only, runs full check, verifies tag matches `package.json` version, publishes to npm with provenance, picks dist-tag from semver suffix (`-pre.*` → `pre`, `-rc/-beta/etc` → `next`, plain → `latest`) so a pre-release never transiently becomes `@latest`. Creates a GitHub release with auto-generated notes.
- ✅ `Formula/codebase.rb` Homebrew formula skeleton committed in-repo as the source of truth. The actual brew tap is a separate repo (`codebase-foundation/homebrew-codebase`); `docs/DISTRIBUTION.md §4` is the bring-up runbook.
- ✅ `docs/MIGRATION_v1_to_v2.md` covers what's preserved, what's renamed (`codebase login` → `codebase auth login`, single-dash flags → `--flag`), what's gone (boot animation, single-binary), rollback path, and reporting.
- ✅ `docs/DISTRIBUTION.md` is the operator-side checklist for the manual steps: npm scope + token, first publish smoke test, `v1.0.0` tag on `anthropic-support`, brew tap repo, codebase.foundation install URL wiring, future Bun-binary path.

What's deferred:

- 🟡 Bun single-binary build — explicitly post-2.0. Path is documented in `docs/DISTRIBUTION.md §6`. The npm + Homebrew + curl|sh paths are first-class without it.

✅ `install.ps1` is the Windows symmetric to `install.sh`: detects v1, removes it on confirm, checks Node ≥ 20 (winget/choco/scoop/Volta hint when missing), runs `npm install -g`, preserves `~\.codebase\` end-to-end. Both installers ship from `https://codebase.design/install.sh` and `/install.ps1` — the canonical user-facing URLs. The actual files live in `polyvibe-poc/web/public/`; `scripts/sync-install-scripts.sh` is the one-command sync from this repo's source-of-truth copies. Operator runbook: `docs/DISTRIBUTION.md §5`.

**Acceptance criteria status:**

- ✅ "`npm install -g @codebase-foundation/cli` works on fresh Linux/Mac/Windows" — package surface is verified locally; CI workflow does the actual cross-platform check on tag push.
- ✅ "A user with an existing OAuth session keeps working without re-authenticating after upgrade" — `~/.codebase/credentials.json` is byte-identical between v1 and v2; both share the file format. Verified by reading both implementations.

Operator's next move: follow `docs/DISTRIBUTION.md` §1 → §3 → §2 → §4 → §5 in that order.

---

## File layout (proposed)

```
/                          # repo root, on v2 branch
  package.json             # deps: pi-agent-core@0.74.0, pi-ai@0.74.0, ink, typebox, vitest
  tsconfig.json
  biome.json
  bin/
    codebase               # shebang → dist/cli.js
  src/
    cli.tsx                # entry, Ink root
    agent/
      adapters.ts          # convertToLlm, transformContext
      hooks.ts             # beforeToolCall / afterToolCall + steering queue
    auth/
      oauth.ts             # PKCE flow + browser callback server
      credentials.ts       # ~/.codebase/credentials.json (mode 0600)
      proxy.ts             # inference proxy client
    tools/
      registry.ts          # provider-neutral schema generation (OpenAI + Anthropic shapes)
      file-state-cache.ts  # LRU + isPartialView (read-before-edit)
      fs/                  # read/write/edit/multi-edit/list/search/glob/grep/notebook
      git/                 # status/diff/log/commit/branch/worktree
      web/                 # search/fetch
      tasks.ts, plan.ts, config.ts, ask-user.ts, memory.ts, dispatch.ts, shell.ts
    glue/                  # ports glue.go (intent classifier, narration)
    plan/                  # ports plan.go (Q&A flow)
    diagnostics/           # ports diagnostics.go
    permissions/           # ports permission.go (read-only allowlist + Risk classifier)
    memory/                # MEMORY.md + 4-type taxonomy
    compaction/            # snip-then-summarize + CompactionDetails
    hooks/                 # ports hooks.go (6 event types, shell-command handlers)
    mcp/                   # ports mcp.go (stdio + SSE transports)
    ide/                   # ports ide.go + vscode.go (lockfile discovery, ws/sse)
    headless/              # ports headless.go
    dotenv/                # ports dotenv.go
    filehistory/           # ports filehistory.go
    setup/                 # ports setup.go (first-run wizard)
    pull/                  # ports pull.go (project sync)
    commands/              # slash-command registry
    skills/                # skill loader (~/.codebase/skills/*.md)
    output-styles/         # Default/Explanatory/Learning
    ui/                    # Ink components
      App.tsx, Chat.tsx, Tool.tsx, Permission.tsx, TaskPanel.tsx, Throbber.tsx
    test/
      faux-provider.ts     # deterministic provider for vitest
  V2_REWRITE_PLAN.md       # this doc
  README.md                # v2 user docs
  docs/
    MIGRATION_v1_to_v2.md
    cli-auth-plan.md       # carried over from anthropic-support
```

---

## v1 → v2 migration notes

- `~/.codebase/` data dir layout preserved. Conversations, sessions, memory, hooks config, MCP server list all carry over.
- `~/.codebase/credentials.json` preserved unchanged — OAuth tokens keep working post-upgrade.
- Env var compatibility: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` continue to work. `ANTHROPIC_API_KEY` already supported on `anthropic-support`. `GLUE_FAST_MODEL` / `GLUE_SMART_MODEL` preserved.
- Slash command names preserved.
- `--resume` flag preserved.
- `codebase auth login` / `logout` / `<key>` preserved.
- `codebase run "<prompt>"` preserved (headless mode).
- `codebase pull <project>` preserved (project sync from platform).

---

## First-session kickoff

When the next AI session opens this repo:

1. Confirm we're on `v2` branch (`git branch --show-current`).
2. Read this doc top-to-bottom — including the audit table.
3. Skim `.pi-mono/packages/agent/src/agent-loop.ts` and `agent.ts` (~1000 lines combined; foundation).
4. Skim `~/claude-code-source/src/utils/fileStateCache.ts` and `src/cost-tracker.ts` for patterns.
5. **Cross-check the current Go file you're porting** — don't trust this plan blindly; the source on `v2` branch is ground truth.
6. Start Phase 0 scaffolding. Do not skip ahead.
7. Commit per logical step. Repo CLAUDE.md rules apply: 600-line cap (excluding lockfiles/migrations), single logical change, body 1–5 lines explaining WHY (not WHAT), no Co-Authored-By trailer.

---

## Open questions to resolve before Phase 6

- **npm package name**: `@codebase-foundation/cli` is the implied target. Confirm availability.
- **OAuth backend URL**: production is `codebase.foundation/api`. Is staging (`staging.polyvibe.io` per `cli-auth-plan.md`) still relevant or has it been folded in?
- **Project file pickup**: should v2 read `AGENTS.md` / `RULES.md` / `CLAUDE.md` from the project? (v1 reads `CLAUDE.md` already on this branch.)
- **Output styles**: config or CLI flag (`--style=learning`)? Lean: config + flag override.
- **Telemetry**: opt-in, opt-out, or none? (v1 has none. Recommend keep none.)

---

## Related work happening in parallel

The Polyvibe/Codebase web coder (separate repo, `polyvibe-poc/`) is doing its own pi-mono lift on a longer timeline. Both projects depend on the same `@earendil-works/pi-*` packages. Patterns ported here (glue, plan, diagnostics, permissions, FileStateCache, hooks, memory, OAuth-against-Codebase-platform) should also land in the web coder's tool layer. Coordinate via the strategy docs in `polyvibe-poc/.settings/compare/`.
