# Claude Code Gap Analysis - 2026-07-07

Scope:

- Codebase CLI: `/Users/j/Documents/New project/codebase-cli-usage-pass`, branch `codex/usage-dogfood-20260705`, starting commit `d013cb3`.
- Comparison source: `/Users/j/source-code-fun/claude-code-source`.
- Method: source inspection plus local CLI dogfood of help/build paths. I did not run the Claude binary; this is a source-backed product/engineering gap analysis.

## Executive Verdict

Codebase is already a credible OSS terminal coder. It has a strong first-run story, OAuth plus BYOK, provider neutrality, local endpoint discovery, task tools, memory, subagents, worktree isolation, checkpoints, rewind, MCP, app-server protocol, and a real end-to-end benchmark harness.

Claude Code is still ahead in product polish and operational depth. Its advantage is not one single feature; it is the way command discovery, task lifecycle, context visibility, memory retrieval/sync, permissions, IDE/LSP hooks, remote continuity, and account policy all reinforce each other. It feels like a complete local-plus-remote operating environment, while Codebase still sometimes feels like a powerful OSS agent with some surfaces not fully productized.

The right strategy is not to clone Claude's whole surface. Codebase can beat it by making reliability visible: benchmark receipts, reversible timelines, provider tournaments, memory provenance, web build handoff, and explicit verification contracts.

## Fix Made During This Pass

While checking launch-facing help, `node dist/cli.js mcp --help` fell through into the interactive TUI instead of showing MCP help. That is exactly the kind of "am I using this wrong?" papercut a new user hits.

Fixed:

- `src/cli.tsx:97` now handles top-level `codebase mcp`.
- `src/cli.tsx:256` lists `codebase mcp` in top-level help.
- `src/cli.tsx:278` prints static MCP setup help and points users back to in-session `/mcp` for live server/tool status.

Verified:

```sh
npm run build
node dist/cli.js mcp --help
node dist/cli.js --help
```

## Where Codebase Is Already Strong

Codebase has several advantages worth leaning into:

- Provider-neutral setup: first-run OAuth, BYOK, env-key detection, and OpenAI-compatible local endpoint scan are all first-class in `src/ui-pi/first-run-wizard.ts`, `src/agent/config.ts`, and `src/config/local-llm.ts`.
- OAuth is launch-facing: PKCE browser flow, localhost callback, manual URL fallback, token refresh, lockfile coordination, and 0600 credential storage are covered in `src/auth/flow.ts`, `src/auth/token-manager.ts`, and `src/auth/credentials.ts`.
- Reversibility is a differentiator: mutating file tools are checkpointed in `src/tools/with-checkpoint.ts`, and `/rewind` restores conversation and file state in `src/commands/builtins/rewind.ts`.
- Task tools are real, not just prompt text: `create_task`, `update_task`, `list_tasks`, and `get_task` support owner and blocker edges in `src/tools/tasks.ts`; persistence and cycle prevention live in `src/tools/task-store.ts`.
- Memory has a clean OSS shape: per-project `MEMORY.md` plus typed files under `~/.codebase/projects/<hash>/memory`, with secret redaction before save in `src/memory/store.ts` and `src/memory/secrets.ts`.
- Subagents are already practical: `dispatch_agent` supports read-only exploration, write-capable work, model/effort overrides, and optional isolated worktrees in `src/tools/dispatch-agent.ts`.
- The benchmark harness is unusually valuable for an OSS CLI: `bench/run.mjs` captures real JSON output, usage, tool calls, verifier output, and transcript behavior; scenarios already cover task fidelity, durable blockers, memory secret hygiene, and complex issue recovery.
- Tournaments and directors are distinctive. Claude has teams/agents, but Codebase can own "try several models/agents and merge the winner" as a user-visible workflow.

## Claude Leads To Close

### 1. Command Discovery And UX Recovery

Claude has a huge command surface: `/diff`, `/context`, `/resume`, `/share`, `/desktop`, `/mobile`, `/keybindings`, `/voice`, `/review`, `/pr_comments`, `/plugin`, `/tasks`, `/doctor`, `/usage`, and many more under `/Users/j/source-code-fun/claude-code-source/src/commands/`.

Codebase has strong commands too, but some capability is split across top-level commands and slash commands in ways a new user has to infer. The `codebase mcp --help` issue was one example. The top-level help should be aggressively forgiving: every advertised concept in the README should have an obvious terminal-level help path, even if the real action happens inside the TUI.

Recommended next work:

- Add top-level help shims for high-interest slash-only topics: `codebase memory`, `codebase permissions`, `codebase agents`, `codebase tournament`, `codebase skills`.
- Make `codebase help <topic>` work as a single umbrella for top-level and slash-command docs.
- Add a launch smoke test that asserts common `--help` invocations never enter the TUI.

### 2. Context Visibility

Claude's `/context` command shows what the model actually sees after transforms, microcompaction, and context analysis (`src/commands/context/context.tsx`). Its compaction system also strips/reinjects special blocks, budgets post-compact restoration, has failure tracking, and surfaces token-warning state (`src/services/compact/*`).

Codebase now has `/context` and `/context explain` wired into the slash-command surface, plus a built-artifact smoke fixture (`npm run build && npm run smoke:context`). The command shows token pressure, compaction threshold, recent/largest messages, task state, memory inventory, latest-prompt memory matches, retained memory reminders, inline files, tools, and compaction summaries. The remaining gap is less "can users inspect context?" and more "can we prove context continuity under ugly long-task pressure?"

Recommended next work:

- Add a benchmark scenario where a long task must survive compaction and still complete from preserved task/memory state.
- Keep `npm run smoke:context` in the launch gate so the compiled slash-command surface keeps proving `/context` and `/context explain`.
- Keep tightening the post-transform visibility story so users can distinguish persisted transcript from transient model-call reminders.

### 3. Task Lifecycle Enforcement

Claude has both classic `TodoWrite` and newer task tools. Its prompts require one active task, immediate updates, blockers, and verification. More importantly, its task update implementation has staleness checks, assignment/mailbox behavior, completion hooks, and a verification nudge when many tasks are closed without a verification step (`src/tools/TaskUpdateTool/*`, `src/tools/TodoWriteTool/prompt.ts`).

Codebase is close. Its system prompt explicitly requires a full plan, one `in_progress`, blocker edges, owner claims, and no false completion (`src/agent/system-prompt.ts:100`). Its task store prevents starting blocked tasks and detects cycles. The remaining gap is enforcement and observability when the model gets lazy.

Recommended next work:

- Add a task-completion guard: when closing three or more tasks without a verification task or recent test/build/shell success, nudge or block final completion.
- Add stale-update protection for task files, similar to file edit "unexpected modification" checks.
- Add `task_output` or "task evidence" so each completed task can point to files changed, commands run, or verifier output.
- Add optional "reliability mode" where final responses are blocked until all non-cancelled tasks are complete and verification evidence exists.

### 4. Memory Retrieval, Sync, And Provenance

Claude's memory system is more productized. The `memdir` prompt defines typed memory files, a `MEMORY.md` index, and careful "write/update/remove" rules. `findRelevantMemories.ts` asks a side model to select up to five clearly useful memory files from headers. Team memory sync is repo-scoped, OAuth-gated, API-backed, size-limited, and guarded by secret scanning before upload (`src/memdir/*`, `src/services/teamMemorySync/*`, `src/services/extractMemories/*`).

Codebase's memory is cleaner and safer than many OSS agents: typed files, index injection, background extraction, manual `#note`, high-confidence secret redaction, and prompt-time relevant-memory recall. The system prompt carries the truncated index, then `src/memory/inject.ts` selects matching full memory bodies with filename/type/source/timestamps/stale markers before the model call. The benchmark surface now includes `memory-retrieval`, which seeds fresh, stale, and unrelated memories and fails if the agent uses stale or distractor values.

Recommended next work:

- Add `forget_memory` / `update_memory` as explicit tools and slash commands.
- Store source session id, creation time, last-used time, and optional expiry/reverify hints in memory frontmatter.
- Keep `memory-retrieval` in the public sweep and expand it with more stale-fact cases if retrieval starts looking too easy.
- Add optional web/team memory sync only after local provenance and secret boundaries are crisp.

### 5. Permissions And Shell Safety

Claude has a deeper shell permission classifier. It extracts stable command prefixes, suggests scoped allow rules, blocks overly broad shell wrappers, has mode-specific validation, and maintains a detailed read-only command validation layer (`src/tools/BashTool/bashPermissions.ts`, `modeValidation.ts`, `readOnlyValidation.ts`). It also has richer permission request UI components.

Codebase has the right philosophy: explicit permissions, always-allowed read tools, reversible/irreversible classification, shell warnings, scoped shell trust, and live permission prompts that now show safer-path guidance plus exact scoped allow/deny commands (`src/permissions/store.ts`, `src/permissions/reversibility.ts`, `src/tools/shell-validator.ts`, `src/tools/permission.ts`). The remaining gap is deeper classification and preview tooling, especially before long autonomous tasks.

Recommended next work:

- Keep expanding command-prefix extraction for more CLIs and framework-specific subcommands.
- Separate "read-only shell" from "mutating but reversible" more visibly in the prompt UI.
- Add a permissions simulator: given a task or command, explain what would be auto-allowed, prompted, or denied.
- Add benchmark cases for denied shell commands, recovery from denial, and scoped trust.

### 6. File Editing And IDE/LSP Awareness

Both systems enforce read-before-write and unexpected-modification safety. Claude adds richer IDE/LSP hooks, diagnostics, permission previews, file history hooks, notebook behavior, and special cases around settings folders (`src/tools/FileEditTool/*`, `src/tools/FileWriteTool/*`, `src/tools/LSPTool/*`).

Codebase's file edit tools are clean: exact `old_string`, atomic multi-edit, BOM/EOL/mode preservation, and checkpointed mutations (`src/tools/edit-file.ts`, `src/tools/write-file.ts`, `src/tools/multi-edit.ts`, `src/tools/with-checkpoint.ts`). The visible gap is language intelligence and diagnostics.

Recommended next work:

- Add read-only LSP tool operations: definition, references, hover, symbols, diagnostics.
- Let the agent ask for diagnostics after edits before running full tests.
- Surface file edit previews and checkpoint ids more directly in the TUI so rewind feels like a first-class safety net.

### 7. Remote/Web/App Continuity

Claude has a serious remote bridge: trusted devices, desktop/mobile commands, session runner, remote session manager, websocket continuity, sharing, and remote policy/settings refresh.

Codebase has the beginning of a strong web bridge in `src/app-server/server.ts` and `src/app-server/protocol.ts`: JSONL lifecycle, agent events, permission requests, usage updates, images, state, and messages. But `set_model` is explicitly not supported in app-server mode yet, and build/project orchestration is still thin.

Recommended next work:

- Implement `set_model` in app-server mode.
- Add a web-auth E2E that starts the CLI app-server, authenticates, runs a build, streams usage, handles a permission request, and persists the transcript.
- Add `codebase project build <id>` or equivalent web handoff once the web app API is ready.
- Make `/share` or `codebase share` create a redacted, reproducible transcript bundle.

## P0 Launch Work

These are the highest leverage items before a public push:

1. Help/discovery smoke suite.
   - Assert `codebase --help`, `auth --help`, `project --help`, `ssh --help`, `usage --help`, `doctor --help`, `director --help`, `mcp --help`, `run --help`, and `auto --help` all exit without entering the TUI.

2. `/context`.
   - Keep this as a launch smoke gate: summary and explain should show context budget, compaction state, task state, memory inventory, and latest-prompt memory matches.

3. Task verification guard.
   - Do not let complex work end with a pretty final answer and no evidence. Nudge before final when task tools are active and no verifier ran.

4. App-server model switching and usage events.
   - The web app/CLI bridge should demonstrate a complete OAuth -> prompt -> permission -> build -> usage update path.

5. Memory update/forget + provenance hardening.
   - Relevant body recall now exists; the launch gap is explicit update/delete UX plus stronger source session, last-used, and stale/reverify metadata.

6. Permission UX polish.
   - Live permission prompts now show scoped trust/persist guidance; clearer irreversible/reversible/read-only language and simulator previews remain.

## P1/P2 Work

P1:

- LSP read-only tools and diagnostics.
- Memory provenance, expiry, and explicit update/forget commands.
- Packaged benchmark command or `codebase doctor --bench`.
- Shareable transcript/debug bundle with secrets redacted.
- In-session auth re-entry for users who type `/auth` after config expires, not just instructions to exit.
- Web project pull/build/deploy flow once API endpoints are stable.
- Cross-project/session resume UX similar to Claude's same-project/all-project picker.

P2:

- PowerShell/Windows shell safety parity.
- Plugin marketplace/registry UI.
- Team memory sync.
- Voice/mobile/desktop continuity.
- Cron/scheduled agents.
- PR comment subscription/review workflows.

## Above-Claude Ideas

These are the places Codebase can be better, not merely compatible.

### 1. Verifiable Agent Receipts

Make every serious run produce a compact evidence packet:

- task plan and final task states
- files changed
- commands run and exit codes
- permission prompts and approvals
- tests/builds/verifiers
- memories saved/read
- model/provider/cost/usage
- rewind checkpoints

Then let users run `codebase receipt`, `codebase share --redacted`, or open it in the web app. Claude feels polished; Codebase can feel inspectable and trustworthy.

### 2. Benchmark-First OSS Credibility

You already have `bench/`. Make it a public product surface:

- `codebase bench run --suite launch`
- `codebase bench compare --cli claude --cli codebase`
- markdown scorecards with pass rate, median time, cost, tool behavior, task fidelity, and memory hygiene
- a README badge or hosted leaderboard for real scenarios

An OSS agent can win trust by showing receipts. Claude cannot easily let the community reproduce its internal evals.

### 3. Provider Tournament As A First-Class Workflow

Tournaments are a great wedge. Push beyond "multiple agents race" into:

- model-vs-model scorecards on the user's repo
- cost/speed/quality tradeoff summary
- merge winner with checkpoint safety
- remember per-repo model preferences from prior tournament outcomes
- "run cheap model first, escalate only on failure" policies

This turns provider neutrality from a checkbox into an actual superpower.

### 4. Reversible Timeline UI

Codebase's checkpoint/rewind model can become a better safety story than Claude's:

- every prompt produces a timeline node
- every edit attaches a diff preview
- every command attaches output and status
- every memory write attaches provenance
- every permission decision attaches risk class
- `/rewind` and the web UI can jump to any node

This is "git for agent work" at the interaction level, and it fits Codebase's current architecture.

### 5. Reliability Mode

Add a mode users can trust on scary tasks:

```sh
codebase auto --reliable "fix the auth refresh race and prove it"
```

Reliable mode now requires:

- task list for non-trivial work
- one active task at a time
- verification evidence tied to task work
- no final success claim while tests fail
- no unresolved blockers
- evidence receipt attached to final answer

This is easy to understand and hard to fake. The next upgrades are broader public receipt sweeps, richer receipt presentation, and benchmark scenarios that try to trick final-answer proof, task evidence, and fresh-verification checks.

### 6. Memory With Provenance And Expiry

Most agent memory rots. Codebase can do better:

- every memory has source session, timestamp, confidence, and optional expiry
- project memories can include "verify with command/file before trusting"
- stale memories are shown as stale, not silently injected
- memories can be used as benchmark artifacts

This would make Codebase memory safer than "the agent remembered something, good luck."

### 7. Web Build Handoff

Because Codebase has OAuth and a web app, make the CLI and web app one workflow:

- start local work in CLI
- push/zip/build in web
- stream build logs back into CLI
- show usage/credits live
- archive transcript and artifacts
- resume from web or CLI

Claude has remote continuity; Codebase can have open, project-centered build continuity.

### 8. Privacy/Local Mode

Lean into local endpoint scanning:

- `codebase local doctor`
- "no cloud egress" mode
- local model benchmark
- local-only memory/session storage guarantee
- clear warning when a tool would call network

This is a strong OSS wedge against proprietary tools.

### 9. Permission Policy Simulator

Before a risky task, let users preview:

```sh
codebase permissions simulate "upgrade deps and run migration"
```

Output:

- likely commands
- read-only operations
- reversible edits
- irreversible operations that will prompt
- suggested scoped approvals

That would make autonomous work feel much less spooky.

### 10. Open Skill/Plugin Registry With Tests

Claude has plugins/skills, but Codebase can make installable skills reproducible:

- skill manifest declares tools, permissions, and tests
- `codebase skill test <skill>`
- `codebase skill trust <skill> --scope project`
- community registry with benchmark results

This fits OSS culture and can create distribution.

## Benchmark Suite To Add

Add these scenarios before launch or soon after:

- `help-discovery`: runs common help commands and fails if any start the TUI or require auth.
- `context-survival`: long task triggers compaction; verifier checks task/memory continuity and final code.
- `memory-retrieval`: seeds several memory files; prompt requires using the relevant one and not the distractors.
- `permission-denial-recovery`: agent proposes risky shell, denial occurs, agent recovers with safer read-only path.
- `reliable-mode`: complex issue must track tasks, run verification, and cannot finish with open blockers.
- `app-server-build`: launches app-server, sends initialize/prompt/permission response, expects usage and final events.
- `model-tournament`: runs two cheap fake CLIs or real providers and verifies winner merge/report shape.
- `web-auth-smoke`: with mock OAuth/API, validates PKCE, token persistence, refresh, and usage rendering.

## Source Evidence Pointers

Claude source:

- Commands: `/Users/j/source-code-fun/claude-code-source/src/commands/`
- Tool inventory: `/Users/j/source-code-fun/claude-code-source/src/tools.ts`
- Task tools: `/Users/j/source-code-fun/claude-code-source/src/tools/TaskCreateTool/`, `TaskUpdateTool/`, `TaskListTool/`, `TodoWriteTool/`
- Memory: `/Users/j/source-code-fun/claude-code-source/src/memdir/`, `/Users/j/source-code-fun/claude-code-source/src/services/extractMemories/`, `/Users/j/source-code-fun/claude-code-source/src/services/teamMemorySync/`
- Permissions/shell: `/Users/j/source-code-fun/claude-code-source/src/tools/BashTool/`
- Context/compaction: `/Users/j/source-code-fun/claude-code-source/src/commands/context/`, `/Users/j/source-code-fun/claude-code-source/src/services/compact/`
- Resume/remote bridge: `/Users/j/source-code-fun/claude-code-source/src/screens/ResumeConversation.tsx`, `/Users/j/source-code-fun/claude-code-source/src/bridge/`, `/Users/j/source-code-fun/claude-code-source/src/remote/`, `/Users/j/source-code-fun/claude-code-source/src/server/`
- LSP: `/Users/j/source-code-fun/claude-code-source/src/tools/LSPTool/`

Codebase source:

- First run/auth/config: `src/ui-pi/first-run-wizard.ts`, `src/auth/flow.ts`, `src/auth/token-manager.ts`, `src/auth/credentials.ts`, `src/agent/config.ts`, `src/config/local-llm.ts`
- CLI top-level help: `src/cli.tsx`
- Tasks: `src/tools/tasks.ts`, `src/tools/task-store.ts`, `src/ui-pi/task-panel.ts`, `src/agent/system-prompt.ts`
- Memory: `src/memory/store.ts`, `src/memory/inject.ts`, `src/memory/extractor.ts`, `src/memory/secrets.ts`, `src/tools/memory-tools.ts`
- Subagents: `src/tools/dispatch-agent.ts`
- Permissions: `src/permissions/store.ts`, `src/permissions/reversibility.ts`, `src/tools/shell-validator.ts`, `src/tools/permission.ts`
- File editing: `src/tools/edit-file.ts`, `src/tools/write-file.ts`, `src/tools/multi-edit.ts`, `src/tools/with-checkpoint.ts`
- Context/session/rewind: `src/compaction/engine.ts`, `src/compaction/monitor.ts`, `src/sessions/store.ts`, `src/commands/builtins/session.ts`, `src/commands/builtins/rewind.ts`
- App server: `src/app-server/server.ts`, `src/app-server/protocol.ts`
- Benchmarks: `bench/README.md`, `bench/run.mjs`, `bench/scenarios/`
