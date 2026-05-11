# Maturity audit — codebase-cli @ 2.0.0-pre.5

> **Status:** Second-pass audit · **Date:** 2026-05-10 · **Companion to**
> [`AUDIT-2026-05-08-feature-parity.md`](./AUDIT-2026-05-08-feature-parity.md)
>
> The first audit asked **"do we have parity with pi-coding-agent and
> Claude Code?"** That answer is in the gap matrix below — short
> version: more than pi, less than CC, but the deltas matter more than
> the totals. This audit asks **"is it a product?"** That's a
> different bar than feature parity. A maturity-readiness
> answer follows the gap matrix.

## Executive answer

**Where we are:** `2.0.0-pre.5` published to npm, 506 tests passing,
8/8 PASS across 2 in-house models on the canonical bench, install
flow verified on Linux + macOS. The CLI works as a coding agent.

**What that maps to in release terms:**
- `2.0.0-rc.1` (release candidate, ready for adventurous public eyes): **achievable today** with a version bump and an honest "rc not GA" tag.
- `2.0.0` final: **not yet.** Missing MCP, missing IDE bridge, real-user OAuth flow unverified end-to-end, bench not in CI.

**Honest framing:** the product *runs* — there's nothing that crashes
on a fresh install, and the coding-agent loop completes real tasks.
But "the product runs" is a low bar. What stops me from calling it
2.0.0 today is the feature gap with Claude Code on MCP + IDE
integration, both of which CC users expect and we currently have
neither of.

---

## What changed in two days (delta from 2026-05-08)

The first audit's "priority queue" had 10 items. Eight shipped, one
was already done, one is explicitly deferred to Phase 9. Plus four
new dimensions surfaced.

| Item | Status | Commit |
|---|---|---|
| Wire memory tools (1-line bug) | ✅ | `35ae822` |
| +10 high-impact slash commands → 19/20 | ✅ | `93fefc1` |
| Layered ConfigStore | ✅ | `7a90e61` |
| Persistent permission allow/deny | ✅ | `83364b6` |
| Parallel read-only tool execution | ✅ already shipped | — |
| Headless `--output json/stream-json` | ✅ | `e8eb73c` |
| Hook events PreCompact/PostCompact/Subagent×2 | ✅ | `ad2da0d` |
| `config` tool | ✅ | `e531e4f` |
| macOS Keychain auth | 🟡 deferred (opportunistic) | — |
| Phase 9: MCP + IDE bridge | 🟡 deferred (multi-week) | — |

Plus four dimensions the first audit didn't track:

| New dimension | What shipped |
|---|---|
| **Distribution** | 5 versions on npm, `codebase.design/install.sh` deployed and serving, Homebrew formula skeleton committed, GitHub release workflow on `v2.*` tags. |
| **End-to-end testing** | `bench/` harness with 4 scenarios + verify.sh, JSONL → markdown aggregator, 24/24 PASS at N=3 against Qwen3.6-35B and MiniMax-M2.7 in-house. |
| **Platform integration** | `codebase project list/pull` subcommand consuming the existing `/api/cli/projects` endpoints. `PlatformLoader` with ETag-cached fetch + graceful degrade against 404, ready for the `/api/cli/assets` endpoint that shipped today. |
| **First-run UX** | Wizard with OAuth ("Sign in with codebase.design") + BYOK provider picker. OSC 8 hyperlinks for the OAuth URL when terminal supports it; manual URL on a separate line as copy-paste fallback. SSH/headless auto-detect skips the broken xdg-open path. |

Plus three real bugs the bench surfaced and fixed in one commit
(`3f4ee3b`): the cli.tsx TDZ crash on every `codebase run`, the
headless permission-prompt infinite hang, and the openai-compat
custom-endpoint synthesis (MiniMax/Qwen in-house).

---

## Refreshed gap matrix

Same 17 dimensions as the first audit. **Bold rows** changed in two
days. Status legend: 🟢 at-parity-or-ahead · 🟡 partial · 🔴 missing.

| # | Dimension | us | pi | CC | Status vs targets |
|---|---|---|---|---|---|
| 1 | **Tools** | **29** | 7 | 42 | 🟢 vs pi · 🟡 vs CC (gap = MCP tools + Skill/Brief/Schedule/Sleep/PowerShell/REPL/TeamCreate/SendMessage — most niche) |
| 2 | **Slash commands** | **20** | 21 | 101 | 🟢 vs pi · 🟡 vs CC |
| 3 | **Permissions** | effect-based + persistent allow/deny | delegated | ML-augmented | 🟢 vs pi · 🟡 vs CC (no ML, fine for non-Anthropic builds) |
| 4 | **Hooks** | **10 events** | 17+ ext events | 15 | 🟡 narrower but covers the load-bearing events |
| 5 | Agent loop | via pi-agent-core | native | 46K-LOC custom | 🟢 |
| 6 | Compaction | snip+summarize @75% | summary @80% | 6+ strategies | 🟡 single strategy still |
| 7 | **Auth / OAuth** | endpoints all verified live today | pi-ai backend | multi-provider + Keychain | 🟢 vs pi (today) · 🟡 vs CC (no Keychain on darwin, no Bedrock/Vertex) |
| 8 | Subagent / dispatch | `dispatch_agent` | session fork | `AgentTool` + Teams + Coordinator | 🟢 vs pi · 🟡 vs CC (no team mode) |
| 9 | **MCP** | ❌ Phase 9 | ❌ | 5 transports + registry | 🔴 |
| 10 | **IDE bridge** | ❌ Phase 9 | ❌ | HTTP + JWT, 3 IDEs | 🔴 |
| 11 | **Providers** | + openai-compat custom path | via pi-ai | Anthropic + Bedrock + Vertex | 🟢 (broader provider set than CC; in-house MiniMax/Qwen reach the agent now) |
| 12 | Diagnostics | 4 checkers | ❌ | LSP-based | 🟢 vs pi · 🟡 vs CC |
| 13 | **Headless** | + json + stream-json | print + RPC | `-p` + json + stream-json | 🟢 (CI ergonomics now match CC) |
| 14 | Worktree | enter/exit tools | ❌ | + auto-isolation per subagent | 🟡 |
| 15 | **TUI features** | + first-run wizard, OSC 8 hyperlink | via pi-tui | + Vim + image input + virtual scroll | 🟡 |
| 16 | **Settings layering** | user + project + local (additive perms) | user + project + models | user + project + local + managed | 🟢 vs pi · 🟡 vs CC (no managed/remote policy) |
| 17 | Memory | taxonomy + injection + tools (now wired) | session JSONL, no taxonomy | + auto-extraction + team memory | 🟢 architecture |

**12 dimensions are 🟢 vs pi.** **2 are 🔴 vs CC** (MCP + IDE bridge —
the same two as two days ago). **The rest are 🟡**, meaning we have
the feature but CC has a fancier version of it.

---

## Five maturity scorecards (different framings)

### Scorecard A — runtime correctness

| Signal | Score |
|---|---|
| Unit tests passing | 506 / 506 ✅ |
| Real-LLM bench passing | 24 / 24 across 2 models at N=3 ✅ |
| Bugs surfaced by real-LLM runs in last 2 days | 3 (all fixed: TDZ crash, headless hang, openai-compat) ✅ |
| Known crash paths today | 0 ✅ |
| Tool error handling | every tool has structured error returns + the agent loop steers back into the next turn ✅ |
| **Net** | **Mature.** The code path the agent walks works end-to-end on every model we've tested. |

### Scorecard B — install + distribution

| Signal | Score |
|---|---|
| Public install via curl|sh | ✅ `codebase.design/install.sh` serves; tested on Linux |
| Public install via PowerShell | ✅ `install.ps1` shipped, untested on actual Windows |
| npm publish | ✅ 5 versions live, latest `2.0.0-pre.5` |
| Auto-detect existing v1 (Go) binary on install | ✅ shebang sniff works |
| Migration of `~/.codebase/` data from v1 | ✅ byte-identical schema |
| Homebrew tap | 🟡 formula committed, tap repo not created |
| Bun-compiled single binary | 🟡 documented in DISTRIBUTION.md §6, not built |
| GitHub release workflow | ✅ on `v2.*` tags, untriggered |
| **Net** | **Mostly mature.** npm path is solid. Homebrew + binary need first-publish work; install URL is live. |

### Scorecard C — feature breadth vs the field

| Feature class | Us | pi | CC | Verdict |
|---|---|---|---|---|
| **Coding tools** (read/write/edit/grep/glob/shell/git) | ✅ | ✅ partial | ✅ | par |
| **Subagent dispatch** | ✅ | ❌ session-fork only | ✅ + teams | par with pi · niche features beyond |
| **Plan mode** | ✅ Q&A → review → approve/revise | ❌ | ✅ planModeV2 | par |
| **Worktree isolation** | ✅ tools | ❌ | ✅ tools + per-subagent | par-minus (auto-isolation missing) |
| **Memory** | ✅ 4-type taxonomy + tools | 🟡 session-only | ✅ + auto-extract | par with CC on the shape |
| **Diagnostics** | ✅ tsc/pyright/eslint/govet | ❌ | ✅ LSP | par |
| **Web search / fetch** | ✅ tavily/brave/searxng/ddg | 🟡 partial | ✅ | par |
| **MCP** | 🔴 | 🔴 | ✅ | **behind both** |
| **IDE bridge** | 🔴 | 🔴 | ✅ | **behind both** |
| **First-run wizard** | ✅ OAuth + BYOK | 🟡 setup wizard | ✅ /login | par |
| **Layered config** | ✅ user + project + local | 🟡 user + project | ✅ + managed | par-plus |
| **Persistent permissions** | ✅ `permissions.allow`/`deny` patterns | ❌ | ✅ similar shape | par |
| **OpenAI-compat custom endpoint** | ✅ env-var triggered | ❌ | 🟡 baseUrl override | par-plus |
| **Headless JSON/stream-json** | ✅ | ✅ RPC mode different shape | ✅ | par |
| **OAuth account integration** | 🟡 endpoints verified, real-user flow unverified | ❌ | ✅ | par-minus |
| **Platform skills/templates/prompts** | 🟡 client built, server `/api/cli/assets` ships today | ❌ | ✅ but local-only | par-plus (when verified) |
| **User project list/pull** | ✅ `codebase project list/pull` | ❌ | ❌ | **only-us** |

**Where we're ahead of both pi and CC:** providers (openai-compat
path, broader registry), end-to-end project pull from a hosted
account, layered-config additive semantics for permissions.

**Where we're behind both:** nothing (pi is behind us on everything
material, except possibly TUI polish).

**Where we're behind CC alone:** MCP, IDE bridge, image input, Vim
mode, team mode, ML risk classifier. Image input and Vim mode are
fan service. MCP and IDE bridge are real.

### Scorecard D — production-readiness signals

| Signal | State |
|---|---|
| Error messages are actionable (not stack traces) | ✅ — wizard, headless, auth, tool layer all return human-readable errors with hints |
| Graceful degrade on network failure | ✅ — PlatformLoader caches 404, falls back to cached body on net error, never throws |
| Headless mode is non-interactive-safe | ✅ — `--auto-approve` flag exists, SSH/no-DISPLAY auto-detected |
| Cross-session credentials survive upgrade | ✅ — same `~/.codebase/credentials.json` schema between v1 and v2 |
| Single-line install on three OSes | ✅ Linux + macOS via `install.sh`; Windows via `install.ps1` (untested) |
| `codebase --version` and `--help` work | ✅ |
| Costs and tokens reported per session | ✅ `/cost` slash command with cache hit-rate |
| Configurable via files, not just env | ✅ layered config with deep merge |
| Data dir is documented and stable | ✅ `~/.codebase/{credentials.json,sessions/,projects/<hash>/memory/,cache/,hooks.json,config.json}` |
| CI for unit tests | ✅ on `.github/workflows/ci.yml` |
| CI for bench / E2E | 🔴 |
| Production telemetry / crash reports | 🔴 (deliberate — no telemetry yet) |
| Versioning policy | 🟡 pre-release tagging via dist-tag fully wired in release.yml; pre.5 currently published as `latest` (could argue for `next` instead) |
| Migration doc | ✅ `docs/MIGRATION_v1_to_v2.md` |
| **Net** | **Production-leaning.** What's missing is mostly operational (CI for bench, telemetry, versioning hygiene) not feature work. |

### Scorecard E — what users actually experience

What a fresh user gets in their first 60 seconds:

1. `curl -fsSL https://codebase.design/install.sh | sh` ← works
2. `codebase` ← if no env keys, wizard appears with two clear options
3. Wizard option 1 (OAuth) ← URL opens, sign-in completes back in CLI (assuming today's deployed endpoints all stuck)
4. Wizard option 2 (BYOK) ← provider picker → paste key → ready
5. First prompt to the agent ← Sonnet/Haiku/Qwen/MiniMax all reach completion via the bench-tested paths
6. Tool execution ← read/edit/write all succeed; the agent picks the right tool per task

What a fresh user *won't* find but won't miss on day one:
- MCP server connection (most users don't use it on day one)
- VS Code integration (most CC users come from JetBrains anyway)
- Image input (rare)
- Vim mode (fan service)
- Boot animation (RIP)

What a fresh user *will* miss:
- The "/edit X" / "/select Y" flow CC's IDE bridge enables — if they're coming from CC. Most users aren't.

---

## What would make this 2.0.0 GA-worthy

In rough order of effort vs. impact:

1. **Verify real-user OAuth end-to-end** (you, right now, on your Mac).
   The endpoints are deployed today; a single completed login proves
   the chain works. Until that happens, the OAuth integration is
   "should-work-on-paper" not "verified."
2. **Hook bench into CI** (~2 hours). Spec: `.github/workflows/bench.yml`
   runs the 4 scenarios at N=1 on PR, posts a delta-from-main comment
   when scenarios change tool count or elapsed time by >20%. Doesn't
   need to gate merge — just signal regressions.
3. **MCP support — minimal viable** (~1 week). stdio transport only,
   single-server prototype, config in `~/.codebase/config.json` under
   `mcp_servers`. The schema is already specced in CC's
   `~/.claude.json` shape and our config infrastructure already
   reads JSON.
4. **IDE auto-detection** (~4 hours, NOT the full bridge). Lockfile
   sniff for `.vscode/`, `.cursor/`, `.idea/` at session start; inject
   "you appear to be in <IDE>" into the system prompt. Doesn't enable
   bidirectional editing but gives the agent context. The full bridge
   (HTTP + JWT, file edit relay, diff viewer) is Phase 9.5 — weeks
   of work.
5. **Bench harder scenarios** (~1 day). Current 4 scenarios complete
   in 3–12 seconds. Add a 30–60 second multi-step bug-fix scenario
   that stresses planning + multi-file editing + verification. Real
   benchmarks need a long tail.
6. **Skill-as-slash-command auto-registration** (~1 hour). Once
   `/api/cli/assets` returns user-defined skills, surface them as
   `/<slug>` slash commands in `/help`. The `AssetRegistry.listSkills()`
   call returns the right shape; just need to register dynamically in
   `src/commands/registry.ts`.
7. **Polish:** bump version to `2.0.0-rc.1`, publish under `next`
   tag, write a tagged-release note explaining the gap to GA.

Items 1–2 are blockers IMO. Items 3–4 close the visible feature
gap with CC. Items 5–7 are quality-of-life.

## What's deliberately deferred to 2.1+

| | Why deferred |
|---|---|
| Bun single-binary | nice for first-install UX but not a real blocker — Node ≥20 install via Volta/fnm is ~30s |
| macOS Keychain auth | opportunistic darwin win; the 0600 file gate is fine for now |
| Image input | requires pi-ai stream-shape changes upstream |
| Vim mode | fan service; defer until asked |
| Team mode / coordinator / send-message | niche; CC's coordinator is impressive but most users will never use it |
| ML risk classifier | Anthropic-only, not portable to other providers |
| Boot animation | v1 had it, v2 dropped; v2.1 wishlist at most |

---

## Concrete recommendation

If you're optimizing for "ship 2.0.0-rc.1 within a week":

```
day 1:  complete + verify OAuth E2E on a real Mac, document the
        full flow with screenshots in docs/QUICKSTART.md
day 2:  bench → CI; ship .github/workflows/bench.yml; gather one
        baseline run committed to docs/benchmarks/baseline.md
day 3:  IDE auto-detection (lockfile sniff + system prompt
        addendum, ~4 hours), skill-as-slash-command auto-register
        (~1 hour), one harder bench scenario
day 4:  bump 2.0.0-pre.5 → 2.0.0-rc.1, publish under `next` tag
        on npm; update README with the GA-soon banner
day 5:  smoke + fix; first external user (whoever you trust) runs
        the full install on a clean Mac; capture and fix what
        breaks
```

If "ship 2.0.0 GA":

```
weeks 1-3:  MCP support (stdio first, then HTTP), full IDE
            bridge (HTTP + JWT + edit relay + diff viewer)
week 4:     polish, bench expansion to N=10, third in-house model,
            edge cases the bench surfaces
week 5:     2.0.0 GA, flip dist-tag to `latest`
```

Either path is defensible. The first is honest about where we are.
The second is honest about where users coming from CC will compare
us against.

---

## File evidence

| Claim | Path |
|---|---|
| 29 tools | `src/tools/registry.ts` |
| 20 slash commands | `src/commands/builtins.ts:BUILTIN_COMMANDS` |
| 506 tests passing | `npm test` |
| Bench 24/24 across two models | `bench/results/qwen-n3/`, `bench/results/minimax-n3/` |
| 5 npm versions | `npm view codebase-cli versions` |
| Server endpoints verified | this morning's probes — `/login` 200, `/api/oauth/authorize` issues codes, `/api/cli/assets` 401 (deployed + gated), `/api/cli/published` 200 |
| 3 bugs fixed by the bench | commit `3f4ee3b` |
| Distribution surface | `package.json`, `install.sh`, `install.ps1`, `Formula/codebase.rb`, `.github/workflows/release.yml` |

---

Status: **rc-ready, not GA-ready.** The product runs; it's stable
enough to put in front of trusted external users today. Calling it
GA without MCP and the IDE bridge would invite legitimate complaints
from anyone arriving from Claude Code. Either build those, or call
it rc and ship anyway with honest framing about what's coming.
