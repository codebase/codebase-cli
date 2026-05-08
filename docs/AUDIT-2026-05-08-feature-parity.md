# Feature parity audit — codebase-cli vs pi-coding-agent vs Claude Code

> **Status:** First-pass audit · **Date:** 2026-05-08 · **Scope:** All 17
> dimensions on `src/`. Three tree comparison.

The audit answers one question: **does codebase-cli have at least parity
on most things with pi-coding-agent and Claude Code, and where don't
we?** What follows is the gap matrix, per-dimension details with
file-path evidence, the bugs surfaced during the survey, and the
priority queue this should drive next.

## Trees surveyed

| Tree | Path | Files |
|---|---|---|
| **codebase-cli** (us) | `/home/half/polyvibe-poc/codebase-cli/src/` | 131 .ts/.tsx |
| **pi-coding-agent** | `/home/half/pi-mono/packages/coding-agent/src/` | 136 .ts |
| **Claude Code** | `/home/half/claude-code-source/src/` | 1884 .ts/.tsx |

The two reference projects bracket the design space we live in: pi is
the lean, framework-y SDK that we sit on top of; CC is the maximalist
product with everything wired. Parity with pi is the floor; meaningful
catch-up to CC is the ceiling.

## Gap matrix

Status legend: **🟢** = at parity or ahead · **🟡** = present but
incomplete · **🔴** = missing.

| # | Dimension | us | pi-agent | CC | Status vs targets |
|---|---|---|---|---|---|
| 1 | Tools (count) | **28 (+2 unwired)** | 7 | 42 | 🟡 ahead of pi, behind CC |
| 2 | Slash commands | **9** | 21 | 101 | 🔴 behind both |
| 3 | Permissions | effect-based store | delegated to UI | ML-augmented + AST | 🟢 vs pi · 🟡 vs CC |
| 4 | Hooks (event count) | 6 | 17+ extension events | 15 | 🟡 fewer events |
| 5 | Agent loop | via pi-agent-core | native | 46K-LOC custom | 🟢 |
| 6 | Compaction | snip-then-summarize @75% | summary @80% | 6+ strategies | 🟡 single strategy vs CC |
| 7 | Auth / OAuth | URLs just realigned | pi-ai backend | multi-provider + Keychain | 🟡 single provider, no Bedrock/Vertex |
| 8 | Subagent / dispatch | `dispatch_agent` tool | session fork only | `AgentTool` + Teams + Coordinator | 🟢 vs pi · 🔴 no team mode |
| 9 | MCP | ❌ Phase 9 | ❌ | 5 transports + registry | 🔴 |
| 10 | IDE bridge | ❌ Phase 9 | ❌ | HTTP + JWT, VS Code/JB/Cursor | 🔴 |
| 11 | Streaming / providers | via pi-ai (any) | via pi-ai (any) | Anthropic + Bedrock + Vertex | 🟢 wider provider set than CC |
| 12 | Diagnostics | tsc/pyright/eslint/go-vet | ❌ | LSP-based | 🟢 vs pi · 🟡 simpler than CC's LSP |
| 13 | Headless mode | `codebase run` | print + RPC | `-p` + JSON + stream-json | 🟡 no JSON output yet |
| 14 | Worktree | enter/exit | ❌ | enter/exit + per-subagent isolation | 🟡 tools shipped, isolation TODO |
| 15 | TUI features | kill-ring, plan-mode, OSC52, wrap | via pi-tui | + Vim mode, image input, virtual scroll | 🟡 missing Vim, images |
| 16 | Settings layering | single `~/.codebase/config.json` | user + project + models | user + project + local + managed | 🔴 single layer |
| 17 | Memory | store + injection · **tools unwired** | session JSONL, no taxonomy | + auto-extraction + team memory | 🟢 architecture · 🔴 tools registration bug |

## Bugs surfaced during the audit

1. **Memory tools never registered.** `src/tools/memory-tools.ts`
   defines `createSaveMemory()` and `createReadMemory()` (and a
   `createMemoryTools()` wrapper), but `src/tools/registry.ts:29-54`
   doesn't include them in the tool list. The agent can READ memory at
   session start (MEMORY.md is concatenated onto the system prompt by
   `src/agent/agent.ts:9` + `:103`) but cannot write new entries
   mid-session. **Fix is one line in `registry.ts`.**

2. **Tool count claim is off.** README/V2_REWRITE_PLAN claims "29/30
   tools" but the actual exported count is **28** (with two more
   defined-but-unwired). Reconciles to "30/32" if we count memory
   tools as shipped post-fix, or "28/32" if we treat them as missing.

3. **Permission allowlist preemptively trusts unwired tools.**
   `src/permissions/store.ts:42-44` adds `save_memory` + `read_memory`
   to `ALWAYS_ALLOWED`. They're auto-allowed but unreachable — defensive
   trust on dead code. Once we register them this becomes correct;
   today it's just confusing.

## Detailed dimensions

### 1. Tools

**Us (28 wired):** read/write/edit/multi-edit/notebook-edit, list-files,
glob, grep, shell, web-fetch, web-search, ask-user, dispatch-agent,
plan-mode (×2), tasks (×4), git status/diff/log/commit/branch,
worktree (×2). Defined-but-unwired: `save_memory`, `read_memory`. No
config tool yet (Phase 7).

**pi-coding-agent (7):** read, bash, edit, write, grep, find, ls.
Bundled into `createCodingTools` / `createReadOnlyTools` / `createAllTools`
presets.

**Claude Code (42):** plus REPL, PowerShell, Sleep, Schedule, Brief
(file upload), Send (inter-agent), Team (create/delete), Skill,
TaskOutput/Stop, MCP (×3 — list resources, read resource, search), and
RemoteTrigger.

**Recommendation:** Wire memory tools (1 line), add `config` tool
(deferred from Phase 6/7), then evaluate Brief/Schedule/Sleep — all
useful but lower-priority than the slash-command gap.

### 2. Slash commands

**Us (9):** help, clear, compact, session, cost, model, whoami, copy,
exit.

**pi (21):** plus settings, scoped-models, export, import, share,
name, changelog, hotkeys, fork, clone, tree, login, logout, new,
resume, reload, quit. Skill-as-slash-command auto-registration via
`enableSkillCommands`.

**CC (101):** plus commit, review, mcp, memory, vim, context, doctor,
init, plus dozens of project/agent/team/skill/auth surfaces.

**Recommendation:** This is our biggest visible gap. Highest ROI to
add are: `/commit` (auto-generate commit from diff), `/review` (code
review of uncommitted changes), `/diff`, `/mcp`, `/memory` (browse
saved memories), `/context` (visualize context window usage), `/init`
(project bootstrap), `/resume`, `/login`, `/logout`. That alone takes
us from 9 → 19 commands (parity with pi). Each is a small file in
`src/commands/builtins.ts` if the underlying capability already
exists.

### 3. Permissions / gating

**Us:** `src/permissions/store.ts`. Effect-based gating: a fixed
read-only allowlist (15 tools) auto-allows; everything else asks
once with `allow-once` / `trust-tool` / `trust-all` responses. Trust
state is in-memory, session-scoped. Risk levels: low/medium/high (UI
hint only). Shell-tool special case via `shellNeedsPermission()`.

**pi-coding-agent:** No centralized permission store. Tool-specific
hooks (e.g. `BashSpawnHook.beforeSpawn`) and extension `signal` to
abort. Permission is the application's problem.

**Claude Code:** Largest, most complex of the three. Modes:
`default` / `plan` / `bypassPermissions` / `auto` / `ask`. ML risk
classifier (`bashClassifier.ts`) gates auto-mode per-command; this is
ANT-ONLY in the public build. Hook cascade with conditional
`if`-rules. `~/.claude/settings.json` carries persistent rules.

**Recommendation:** We're already simpler than CC and stronger than
pi. The biggest gap is **persistent trust** — restarting the CLI
forgets all decisions. Adding a `permissions.allow` array to
`~/.codebase/config.json` (CC pattern) is small. Defer the ML
classifier.

### 4. Hooks

**Us (6 events):** PreToolUse, PostToolUse, PostEdit, UserPromptSubmit,
SessionStart, Stop. Config: `~/.codebase/hooks.json`. Shell command
gets event payload as JSON on stdin; exit code 2 = block. Async hooks
fire-and-forget.

**pi (17+ extension events):** SessionStart, BeforeAgentStart,
BeforeProviderRequest, Context, Message×3, Turn×2, ToolExecution×3,
Input, ModelSelect, UserBash, plus per-tool events. Implemented as a
TypeScript extension API (not shell hooks) — extensions register
listeners.

**CC (15 events):** ours plus PostToolUseFailure, SessionEnd,
SubagentStart/Stop, PreCompact/PostCompact, PermissionRequest /
Approved / Denied, Notification. Hook types: command, prompt
(LLM-evaluated), HTTP POST.

**Recommendation:** Add `PreCompact` + `PostCompact` (both hook into
the compaction engine via 1-line callback emits) and
`SubagentStart`/`SubagentStop` (instrument `dispatch_agent`). Skip
prompt-style hooks (LLM-in-loop, expensive) unless asked.

### 5. Agent loop

**Us:** `src/agent/agent.ts` wraps pi-agent-core's loop. Error
recovery: context overflow → forced compaction; rate-limit retry
delegated to pi-ai. Tool dispatch is sequential by default;
read-only tools could go parallel but don't yet.

**pi:** Native loop in `agent-session.ts`. Same recovery pattern.
Sequential tool execution, bash output streamed via `onChunk`.

**CC:** `QueryEngine.ts` (46K LOC). Streaming tool executor,
context-overflow → `PostCompactCleanup`, rate-limit retry in
`services/api/errors.ts`, `maxBudgetUsd` cap.

**Recommendation:** **Parallel read-only tool execution** is the
single biggest perf win available. Mark each tool with `effect:
"read-fs"` etc., and let the dispatcher fire all read-only calls in
the same tool-use round concurrently. Pattern is already in
`docs/ARCHITECTURE.md` Phase 1; just needs to ship.

### 6. Context management / compaction

**Us:** `src/compaction/engine.ts`. Single strategy: threshold 75%
(constant `DEFAULT_THRESHOLD`), snip-then-summarize, safe-split that
walks back to user/assistant-without-tools so tool-call/tool-result
pairs aren't orphaned. Token estimate prefers provider-reported
`usage.totalTokens` over chars/3.8.

**pi:** Threshold 80%, `keepRecentTokens: 20000`, `reserveTokens:
16384`. File-operation tracking persisted in `CompactionEntry.details`.

**CC:** SIX strategies: general `compact`, `microCompact`,
`apiMicrocompact`, snip (feature-gated), `sessionMemoryCompact`,
`autoCompact`. Token budget and cost tracking in
`services/tokenEstimation.ts` + `cost-tracker.ts`. Warning hooks fire
before compaction.

**Recommendation:** Our single strategy is fine for v2.0 GA — CC's
multiplicity is partly because they tried things and never deleted
the losers. Worth adding: a **micro-compaction** that drops oldest
tool-result `text` blocks before triggering full summarize. Cheap,
shaves ~20% off tokens.

### 7. Auth / OAuth

**Us:** Just realigned to web's source-of-truth (this morning's commit
`e2d288a`). PKCE flow at `/login`, token exchange at
`/api/oauth/token`, BYOK now persists per-provider keys to
`credentials.json`.

**pi:** `~/.pi/agent/auth.json` (file-locked, multi-provider in one
file).

**CC:** Anthropic + Bedrock + Vertex routes. macOS Keychain via
`secureStorage/macOsKeychainHelpers.ts`. Pre-flight keychain read at
startup. STS check for Bedrock auto-detection.

**Recommendation:** Keychain integration is high-value for darwin
users (avoids the 0600 file as the only protection). Bedrock + Vertex
support comes free if pi-ai supports them — verify and surface in the
provider picker.

### 8. Subagent / dispatch

**Us:** `dispatch_agent` tool. Subagent types from pi-agent-core.
Worktree tools exist (`enter_worktree` / `exit_worktree`) but the
subagent dispatch doesn't auto-isolate via worktree.

**pi:** Session fork/clone/new — *user-driven* branching, not
agent-spawned helpers. No parallel subagent.

**CC:** `AgentTool` + built-in agents (planAgent etc.) + user-defined
agents in `~/.claude/agents/`. **Team mode** (`TeamCreateTool`,
`SendMessageTool`) for multi-agent parallel work. Coordinator process
gates team tools.

**Recommendation:** Wire `dispatch_agent` to optionally create a
worktree per subagent (small change in tool args). Team mode is large
scope, defer. User-defined agent folders (`~/.codebase/agents/*.md`)
is medium scope — pairs naturally with the platform-fetched skill
loader stub already in `src/skills/`.

### 9. MCP support

**Us:** Nothing. Phase 9 plan.

**pi:** Nothing.

**CC:** Full SDK integration. 5 transports (stdio, HTTP, SSE,
WebSocket, in-process). Server registry. OAuth port polling.
Elicitation handler. Env-var expansion in configs.

**Recommendation:** This is the biggest meaningful gap with CC. Land
in Phase 9. Recommended scope for v2.1: stdio + HTTP transports only,
single-server prototype, expand from there.

### 10. IDE bridge

**Us:** Nothing. Phase 9 plan.

**pi:** Nothing.

**CC:** `bridge/` directory. HTTP + JWT-authed session protocol.
Bidirectional comms (file edit relay, diff viewer, IDE selection
context capture). VS Code, JetBrains, Cursor.

**Recommendation:** Same Phase 9 bucket as MCP. Simpler entry point:
just IDE auto-detection at startup (lockfile sniff for `.vscode/`,
`.cursor/`, `.idea/`) and inject "you appear to be in <IDE>" into the
system prompt. Real bidirectional bridging is much later.

### 11. Streaming / providers

**Us / pi:** pi-ai backbone. Anthropic Messages, OpenAI Responses,
OpenAI Compat (Groq, Ollama, OpenRouter, Cerebras, xAI, Mistral,
DeepSeek, Google). Tool-call streaming.

**CC:** Anthropic-only at the protocol level, but with Bedrock and
Vertex as endpoint variants. Cache control wired into API calls
(prompt + response cache).

**Recommendation:** **We're ahead on provider breadth.** The thing CC
has that we don't is **prompt caching surfacing** — the cacheRetention
field is set to "short" by default in pi-ai. Make it
configurable per-message via system prompt static/dynamic split, then
surface hit rate in `/cost`. We already track input vs cache-read in
`/cost`; the gate is the static-prompt split.

### 12. Diagnostics

**Us:** 4 checkers in `src/diagnostics/checkers.ts` — go vet, tsc,
pyright, eslint. Steered into next agent turn via `agent.steer()`.

**pi:** Nothing built in. Relies on extensions.

**CC:** Full LSP integration (`services/lsp/`). Standard
DiagnosticFile shape with severity ranges. IDE bridge can pull
diagnostics live. Passive feedback loop for non-blocking collection.

**Recommendation:** LSP is the right long-term move (replaces the
hand-rolled checkers, supports any language). Ship in tandem with
the IDE bridge in Phase 9. For now, add the missing common checkers
— **mypy** (Python alternative to pyright), **rustc / cargo check**,
**clippy** — each is ~30 lines.

### 13. Headless mode

**Us:** `src/headless/run.ts` — `codebase run "<prompt>"`. Plain text
to stdout, tool activity to stderr, exits on agent_end.

**pi:** Print mode (one-shot text or `--mode json` event stream) +
RPC mode (bidirectional JSON-RPC over stdin/stdout for embedding).

**CC:** `-p` + structured JSON output + `stream-json` (stream events
as they happen).

**Recommendation:** Add `--output json` and `--output stream-json`
flags to `run`. The events are already structured (`AgentEvent` from
pi-agent-core); just need a serializer. Maybe 80 lines.

### 14. Worktree support

**Us:** `enter_worktree` / `exit_worktree` tools shipped (Phase 3).
But: `dispatch_agent` doesn't auto-isolate.

**pi:** Detects worktree for status display only. No tools.

**CC:** Tools + auto-isolation: subagents created via `AgentTool` get
a fresh worktree by default. `utils/worktree.ts` handles cleanup.

**Recommendation:** As noted under §8 — wire the auto-isolation flag
into `dispatch_agent`'s schema.

### 15. TUI features

**Us:** Kill-ring, word jump, OSC 52 (with tmux DCS pass-through),
plan-mode UI (Q&A → review → approve/revise/cancel), live
TaskPanel + ToolPanel, pre-wrap word-boundary message rendering,
syntax highlight, `/copy` slash command.

**pi:** Same kill-ring/word-jump (delegated to pi-tui package).
Markdown renderer with syntax highlight. No plan mode.

**CC:** All ours, plus **Vim mode** (`/vim` toggle), **image input**
(paste-clipboard, drag-drop, resize), **virtual scroll** for very
long transcripts, selection highlight, copy-on-select.

**Recommendation:** Vim mode is fan service — defer unless asked.
Image input is real-value (multimodal prompts), but pi-ai's stream
shape needs to support it first; check there before building. Virtual
scroll lands for free if we ever hit a transcript-rendering perf
issue; not yet.

### 16. Settings / config

**Us:** Single file `~/.codebase/config.json`. No project-level
override. Schema is loose (no validation).

**pi:** `~/.pi/agent/settings.json` (global, JSONC), project
`./.pi/settings.json`, separate `models.json` for provider/model
config.

**CC:** Three-layer cake:
- `~/.claude/settings.json` (user)
- project `.claude/settings.json` (committed)
- `~/.claude/settings.local.json` (gitignored, local override)
- plus `services/remoteManagedSettings/` for org-managed policy

**Recommendation:** **Add the layered settings model**. Concretely:
read `~/.codebase/config.json` then merge project `./.codebase.json`
on top, then `~/.codebase/config.local.json`. ~50 lines, big UX win.
Defer JSON Schema validation to v2.1.

### 17. Memory

**Us:** `src/memory/store.ts` + `src/memory/inject.ts`.
Per-project at `~/.codebase/projects/<sha256(cwd)[:8]>/memory/`.
4-type taxonomy (user / feedback / project / reference). MEMORY.md
auto-injection capped at 200 lines / 25KB. **Tools unwired (bug §1).**

**pi:** Sessions are JSONL, no cross-session memory store, no
taxonomy.

**CC:** Same taxonomy + **auto-extraction** post-session
(`services/extractMemories/`) + team memory (feature-gated).

**Recommendation:** Wire the tools (1-line fix). Then build
auto-extraction: at session end, ask the cheap-model glue to extract
candidate memory entries and queue them for confirmation on the next
launch. Pairs naturally with the platform-fetched skill loader.

## Priority queue — what to ship next (ordered)

These are ranked by ROI per line of code, not by which is hardest.

1. **Wire memory tools** (1 line, `src/tools/registry.ts`). Makes the
   already-built memory subsystem usable from inside a session.
2. **Add 10 high-impact slash commands** — `/commit`, `/review`,
   `/diff`, `/memory`, `/context`, `/init`, `/resume`, `/login`,
   `/logout`, `/mcp`. Takes us from 9 → 19, parity with pi.
3. **Layered settings** — `~/.codebase/config.json` + project
   `./.codebase.json` + local override. ~50 LOC.
4. **Persistent permission allowlist** — array in config.json that
   skips the prompt for entries matching `<tool>:<arg-pattern>`. CC's
   `permissions.allow` shape is the reference.
5. ~~Parallel read-only tool execution~~ ✅ **already shipped.**
   pi-agent-core's `executeToolCalls` (`agent-loop.js:233-239`)
   honors a per-tool `executionMode: "sequential" | "parallel"` field
   and parallelizes only when every tool in the LLM's batch is
   parallel — otherwise serializes the whole batch for safety. Our
   tool factories are already correctly tagged: read_file, glob,
   grep, list_files, web_fetch, web_search, git_status/diff/log,
   read_memory all `parallel`; everything mutating (write/edit/shell
   /git_commit/save_memory/etc.) `sequential`. Audit was wrong to
   list this as a TODO.
6. **Headless `--output json/stream-json`** — table-stakes for CI use.
7. **Hook events: `PreCompact`, `PostCompact`, `SubagentStart`,
   `SubagentStop`** — small additions, big telemetry value.
8. **`config` tool** — final tool, takes us to 30/30 (or 32/32 with
   memory tools wired).
9. **macOS Keychain auth storage** — opportunistic, dramatic security
   win for darwin users.
10. **Phase 9: MCP + IDE bridge** — biggest single chunk, weeks of
    work, post-2.0.

## Where we already win

The headline: we're **architecturally ahead of pi** on most
dimensions, and **comparable to CC** on the things that matter for a
solo-developer agent CLI. Our 28 tools beat pi's 7. Our diagnostics
engine beats pi's no-op. Our memory taxonomy beats pi's flat session
JSONL. Our permission store with effects beats pi's "delegated to UI"
non-system. Plan mode + dispatch_agent + worktree tools all beat pi's
session-fork-only model.

CC is a different beast — a maximalist product with team mode and
remote-managed settings and ML risk classifiers. Reaching full parity
is not the goal. Reaching **80% of CC's value at 5% of the LOC** is
the thesis from `CLAUDE.md`. By tools-shipped-per-thousand-LOC, we're
already there. The remaining gaps are commands (visible) and
MCP/IDE bridge (architecturally meaningful).

## What's deliberately deferred

- **ML risk classifier** — CC-only, not worth building from scratch.
- **Boot animation / audio** — v1 had it, v2 dropped it. Plan calls
  it v2.1 wishlist.
- **Bun single-binary** — post-2.0 follow-up.
- **Team mode** — CC's coordinator + multi-agent — large scope, niche
  use case.
- **REPL / PowerShell tools** — covered by `shell` tool.

---

Status of this doc: **first-pass.** Fold in observations as we
implement. Re-run the audit before tagging 2.0.0.
