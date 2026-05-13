# Architecture

What's actually in `src/` right now. Grounded in the code, not aspirational.

## The 30-second tour

```
User input → ChatApp (src/ui/App.tsx)
  → if `/cmd`  → CommandRegistry.dispatch (src/commands/)
  → if `!cmd`  → runShellEscape (src/ui/shell-escape.ts)
  → if `@path` → collectAttachments → augmented prompt
  → router.routeUserInput (src/agent/router.ts)
       → "chat"  → glue reply, render synthetically
       → "plan"  → runPlanFlow (src/plan/run-flow.ts) → user approves → agent.prompt
       → "agent" → bundle.agent.prompt(text)
  → pi-agent-core emits AgentEvents over bundle.subscribe(...)
  → useCoalescedAgentEvents flushes them at 16ms intervals into the reducer
  → reducer (src/agent/events.ts) updates ChatState
  → React re-renders the transcript via <MessageList> + <Message> trees
```

## Top-level src layout

| Path | Job |
|---|---|
| `src/cli.tsx` | Entry point. Argv dispatch: `auth`, `project`, `app-server`, `run`, or interactive. |
| `src/agent/` | Reducer, router, system prompt, prompt-suggestion, agent bundle factory. |
| `src/ui/` | The interactive TUI. App, Input, Message, MessageList, Permission, Status, etc. |
| `src/tools/` | All built-in tools (~45 files). Each tool is a self-contained module. |
| `src/commands/` | Slash-command registry + built-in commands (`/help`, `/clear`, etc.). |
| `src/permissions/` | Permission store, policies, effect declarations. |
| `src/plan/` | Plan-mode Q&A, plan generation, plan persistence. |
| `src/auth/` | OAuth PKCE, credential store, login/logout CLI. |
| `src/compaction/` | Conversation compaction strategy + active-state monitor. |
| `src/sessions/` | Per-cwd session save/resume. |
| `src/glue/` | Sidecar (small/cheap model) for routing, narration, suggestions. |
| `src/headless/` | `codebase run <prompt>` one-shot path with structured output. |
| `src/app-server/` | JSON-RPC-ish server over stdio for IDE extensions. |
| `src/projects/` | `codebase project list / pull` against codebase.design. |
| `src/skills/` | Skill files (per-skill SYSTEM.md additions). |
| `src/memory/` | Persistent cross-session memory store. |
| `src/hooks/` | User-configurable hooks (pre/post turn, pre/post tool). |
| `src/diagnostics/` | Post-edit language checkers (TS, Python, etc.). |
| `src/dotenv/` | `.env` loader, runs before anything reads `process.env`. |
| `src/clipboard/` | Cross-platform clipboard helper for `/copy`. |
| `src/user-queries/` | Programmatic "ask the user a question" pubsub used by plan-mode + tools. |
| `src/config/` | XDG config dirs + model resolution. |
| `src/types.ts` | `ChatState`, `ToolExecution`, shared types. |

## The reducer (src/agent/events.ts)

The chat UI's state machine. 176 lines. Inputs:

- **Actions** dispatched by App.tsx: `user-prompt`, `chat-reply`, `abort`,
  `error`, `reset`, `agent-event`.
- **Agent events** wrapped inside `agent-event`: `agent_start`, `turn_start`,
  `message_start`, `message_update`, `message_end`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end`.

Output: a new `ChatState` (immutable) with updated `messages`, `tools`,
`status`, `usage`, `streaming`.

Hot paths (`message_update`, `tool_execution_update`) get hammered during
streaming. They allocate a new Map per update — that's intentional so React
sees a new reference and re-renders.

## Streaming pipeline

`bundle.subscribe(handler)` fires for every AgentEvent. We coalesce in
`src/ui/use-coalesced-agent-events.ts`:

- `message_update` events overwrite a single "msg" slot in `pendingRef`.
- `tool_execution_update` events get one slot per `toolCallId`.
- All other events flush the pending queue immediately, then dispatch
  themselves — preserves ordering of terminal events relative to the
  updates they finalize.
- A 16ms timer drains the queue (60fps cap).

The microbenchmark at `src/agent/events.bench.ts` validates the reducer
handles 10M+ events/sec — coalescing exists to spare React renders, not
the reducer.

## Tools

Each tool in `src/tools/` exports a `Tool` definition:

```ts
{
  name: "read_file",
  description: "...",
  parameters: TypeBox schema,
  effects: ["reads_fs"],
  execute: async (args, ctx) => { ... },
}
```

`ctx` (the tool context) gives access to: cwd, permissions, abort signals,
the session-wide task store, the file-state cache, and the streaming
`onUpdate` callback (for shell stdout pass-through).

Tools come in roughly three flavors:
- **Read-only filesystem** (`read_file`, `list_files`, `glob`, `grep`,
  `notebook_read`) — declare `reads_fs`, generally auto-approved.
- **Write/edit** (`write_file`, `edit_file`, `multi_edit`, `notebook_edit`) —
  declare `writes_fs`, prompt for permission unless trusted.
- **Action** (`shell`, `web_fetch`, `web_search`, git family, `dispatch_agent`,
  `enter_worktree`/`exit_worktree`) — declare appropriate effects.

Plus the introspection tools: `create_task`/`update_task`/`list_tasks`/`get_task`,
`save_memory`/`read_memory`, `config`, `ask_user`, `enter_plan_mode`/`exit_plan_mode`.

## Slash commands

`src/commands/registry.ts` owns the registry; `src/commands/builtins.ts` ships
the built-in set. Input starting with `/` flows through `registry.dispatch`,
which falls through to the agent if the command is unknown. The registry
also does Levenshtein-distance typo suggestions.

## Permissions

`src/permissions/store.ts` is a pubsub that surfaces the next pending
`PermissionRequest` to the UI. `<Permission>` renders the prompt; user
choice resolves the promise the tool is awaiting. Policies in
`src/permissions/policies.ts` match on effects + arg patterns (paths,
URLs) and can pre-approve / pre-deny categories.

## Glue sidecar

A second LLM client targeted at a cheaper/faster model. Used for:

- **Router** (`src/agent/router.ts`) — classify input as chat / plan / agent
- **Narration** (`src/glue/narration.ts`) — short status lines while busy
- **Plan Q&A** (`src/plan/flow.ts::generateQuestion`) — clarifying questions
- **Prompt suggestion** (`src/agent/prompt-suggestion.ts`) — ghost-text next prompt

If the glue model is unconfigured or fails, every callsite has a graceful
fallback (router falls back to agent, narration silently no-ops, etc.).

## Session persistence

`src/sessions/store.ts` saves per-cwd transcripts to `~/.codebase/sessions/`.
By default, launching `codebase` in a cwd auto-resumes the prior session
if it's <7 days old. `--new` (or `--fresh`) skips resume.

## What the TUI components do

| Component | Responsibility |
|---|---|
| `App` | Top-level: bootstrap, first-run wizard gate, render `ChatApp`. |
| `ChatApp` | State wiring, lifecycle hooks, render tree. |
| `MessageList` | Memoized list of `<Message>`s with `<Static>` for finalized turns. |
| `Message` | One message: user / assistant / tool result. Delegates to specialized children. |
| `ToolCallLine`, `CollapsedReadGroup` | Per-tool rows with running spinner / done check / error glyph. |
| `DiffSummary` | +N/-M diff with word-level highlight for edit_file / multi_edit / write_file. |
| `TruncatedOutput` | Head/tail trim for long tool output (per-tool caps). |
| `Input` | Multi-line input with command/path completion, history, ghost-text. |
| `Permission`, `UserQueryView` | Modal-ish overlays for approval + arbitrary user questions. |
| `Status` | Bottom bar: model, cwd, tokens, elapsed, busy indicator. |
| `ToolPanel`, `TaskPanel` | Compact per-tool / per-task status panels. |
| `Welcome`, `FirstRunSetup` | Initial empty-state + provider config wizard. |

## What lives outside `src/`

- `bench/` — end-to-end LLM benchmarks (real API calls, scenario-driven).
- `docs/` — historical architecture notes (some still Go-era), benchmark results.
- `bin/codebase` — published CLI entry that requires `dist/cli.js`.
- `.settings/` — this folder.
