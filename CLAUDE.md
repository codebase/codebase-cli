# CLAUDE.md — codebase-cli

## What this is

A TypeScript coding-agent CLI on top of the pi-mono runtime
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`). We layer the
TUI, tools, slash commands, permissions, OAuth, sessions, and the headless
/ JSON-RPC entry points; pi-mono owns the agent loop and provider
protocols.

Goals: simple architecture, any LLM provider, single `npm i -g` install,
designed to fit cleanly in a terminal session.

For deep context, read [`.settings/`](.settings/) first — `tenets.md`,
`architecture.md`, `extending.md`, `testing.md`. Those are the canonical
docs; this file is the quick reference.

## Quick reference

```
Language:    TypeScript (ESM), Node ≥ 20
TUI:         ink (React for terminals)
Schema:      typebox (runtime validation of tool args)
Tests:       vitest 2.x
Lint/format: biome 2.x
Build:       tsc → dist/, no bundler
Binary name: codebase
Config dir:  ~/.codebase/
Sessions:    ~/.codebase/sessions/<cwd-hash>/
```

## Build & run

```sh
npm run build                       # tsc + chmod
npm run check                       # typecheck + lint + tests (the pre-publish gate)
node dist/cli.js                    # interactive TUI in current dir
node dist/cli.js --new              # skip auto-resume of prior session
node dist/cli.js run "<prompt>"     # one-shot headless
node dist/cli.js run --output json "<prompt>"
node dist/cli.js auth login         # OAuth via codebase.foundation
node dist/cli.js app-server         # JSON-RPC over stdio (for IDE extensions)
```

## Test & bench

```sh
npm test                            # all unit tests (576+)
npm test -- -t "name fragment"     # filter
npm run test:watch
npm run bench:micro                 # vitest microbenchmarks (*.bench.ts)
npm run bench                       # end-to-end LLM bench (needs API key)
```

## Architecture in 60 seconds

```
User input → ChatApp (src/ui/App.tsx)
  → /cmd     → CommandRegistry (src/commands/)
  → !cmd     → runShellEscape (src/ui/shell-escape.ts)
  → @path    → collectAttachments → augmented prompt
  → router (src/agent/router.ts) → chat | plan | agent
  → bundle.agent.prompt(text)         # pi-agent-core owns the loop
  → AgentEvents stream over bundle.subscribe(...)
  → useCoalescedAgentEvents flushes at 16ms (60fps cap)
  → reducer (src/agent/events.ts) → ChatState → React render
```

Full src layout, data flow, and component responsibilities live in
[`.settings/architecture.md`](.settings/architecture.md).

## Environment variables

### Provider credentials
Provided per-provider via pi-ai's resolver. The first-run wizard
detects what's set and offers it. Common ones:

```
OPENAI_API_KEY          OpenAI (also catches any OAI-compatible endpoint)
OPENAI_BASE_URL         override endpoint for OAI-compatible providers
ANTHROPIC_API_KEY       Anthropic
GROQ_API_KEY            Groq
OPENROUTER_API_KEY      OpenRouter
```

OAuth users sign in via `codebase auth login`; tokens land in
`~/.codebase/credentials.json` and `process.env` is not required.

### Web search (only if `web_search` tool is invoked)
```
TAVILY_API_KEY          Tavily (recommended)
BRAVE_API_KEY           Brave Search
SEARXNG_URL             self-hosted SearXNG instance
```

### Behavior toggles
```
CODEBASE_FRESH=1              skip auto-resume of prior session (same as --new)
CODEBASE_NO_SUGGESTIONS=1     disable ghost-text prompt suggestions
CODEBASE_DEBUG=1              verbose stderr logging
CODEBASE_DEBUG_INPUT=1        log every keystroke to ~/.codebase/logs/input.log
NO_HYPERLINK=1                disable OSC 8 clickable file paths
```

### Unrestricted mode (trust-the-developer escape hatches)

By default the agent has three soft guards. Each one has an opt-out
env var, and `--unrestricted` (alias `--yolo`) sets all three:

```
CODEBASE_NO_PROJECT_ROOT=1      file/shell tools can read/write/cd anywhere
                                the running user can. Default: clamped to cwd.
CODEBASE_NO_VALIDATOR=1         shell tool skips the rm -rf / dd / fork-bomb
                                hard blocks. Default: those patterns refuse.
CODEBASE_NO_READ_BEFORE_WRITE=1 write_file / edit_file proceed even when the
                                model never read the file in this turn.
                                Default: refused with FileNotReadFirstError.
```

When ANY of these are set, the CLI prints a yellow banner at session
start enumerating which restrictions are off — so you don't run
unrestricted by accident. Philosophy: defaults are conservative so
new users can't accidentally trash their machine; opt-outs let power
users tell us "I trust this agent on this box, get out of the way."

### OAuth (only override if you know why)
```
CODEBASE_CLIENT_ID      override OAuth client id
CODEBASE_SCOPES         override requested scopes
```

`.env` and `.env.local` in the cwd are auto-loaded at startup
(`src/dotenv/loader.ts`).

## Coding conventions

### TS style
- ESM imports with `.js` extensions (TS NodeNext convention).
- `import type { ... }` for type-only — biome enforces this.
- Tabs for indentation (biome config). Single quotes off (double quotes).
- Errors thrown as `Error` subclasses with descriptive names
  (`ConfigError`, `PermissionDeniedError`, `UserQueryCancelled`, etc.).
- Default to no comments. Add one only when *why* is non-obvious.
- No multi-paragraph JSDoc blocks. One short line max.

### Files
- One responsibility per file. If a file passes ~400 lines, look for
  a seam — see how `Message.tsx` and `App.tsx` were split.
- Tests colocated as `*.test.ts` / `*.test.tsx` next to source.
- Benchmarks colocated as `*.bench.ts` next to source.
- Component files use PascalCase (`Message.tsx`); modules use kebab-case
  (`tool-call-line.tsx`, `diff-summary.tsx`).

### What to avoid
- Don't `as unknown as` to smuggle a field through an interface. Fix the
  interface.
- Don't add a feature flag for backwards-compat of code you're rewriting
  in the same PR. Just change it.
- Don't add a runtime dependency for something stdlib + the existing deps
  can do.
- Don't reach into pi-agent-core / pi-ai internals. Public API only; if
  it's not enough, fix it upstream.
- Don't commit aspirational documentation. The code is the spec; docs
  follow the code.

## Architectural shape

A few load-bearing decisions you should know going in:

- **One `Tool` interface** for everything (~45 implementations in `src/tools/`).
  Adding a tool is mechanical: declare effects, validate args with TypeBox,
  export. No per-tool snowflakes.
- **Effect-based permissions** (`reads_fs`, `writes_fs`, `runs_shell`,
  `network`). Policies match on effects, not tool names. ~600 LOC total.
- **Single immutable `ChatState`** driven by a typed reducer in
  `src/agent/events.ts`. Every UI state transition flows through it; the
  reducer is tested exhaustively in `events.test.ts`.
- **One proactive compaction strategy** with a calibrated token budget.
  See `src/compaction/`.
- **Plain `npm i -g`** distribution. `tsc` only, no bundler.

## Recognized project files

The CLI auto-loads these from the project root and injects them into
the system prompt:

- `AGENTS.md`
- `CLAUDE.md`
- `CODEX.md`
- `.cursorrules`

## Output styles

Reshape how the agent writes its answers (terse / explanatory /
report-mode / …) without touching the base prompt. Markdown files in
`~/.codebase/output-styles/<name>.md` (user) or
`<cwd>/.codebase/output-styles/<name>.md` (project, wins on id clash):

```markdown
---
name: Terse
description: One-liners, no preamble.
---
Answer in as few words as possible. Skip restating the question.
```

`/output-style` lists them, `/output-style <id>` activates one (the
body is appended to the system prompt and the agent rebuilds in place),
`/output-style off` clears it. The choice persists in
`~/.codebase/config.json`. Same frontmatter parser as skills
(`src/config/frontmatter.ts`).

## Direct dependencies

Runtime:
- `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` — agent loop + protocol adapters
- `ink` + `react` — TUI
- `typebox` — runtime schema validation for tool args
- `diff` — LCS-paired diffs for the `edit_file` / `multi_edit` summary
- `glob`, `ignore` — file matching for tools

Dev:
- `vitest`, `@biomejs/biome`, `typescript`, `tsx`, `shx`, `@types/*`

Don't add a dep without a real second use case in mind. The stdlib +
the deps above can do almost everything.

## Hooks

User-configurable shell commands that fire on agent lifecycle events.
Loaded from `~/.codebase/hooks.json` (user) and `./.codebase/hooks.json`
(project, merged after user). Each hook gets the event context as JSON
on stdin so shell hooks can `jq` whatever fields they care about.

### Schema

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "edit_file|write_file:src/**",
      "command": "scripts/lint-staged.sh",
      "timeout": 15000,
      "async": false
    }
  ]
}
```

### Events that fire

```
PreToolUse        before any tool runs — exit 2 to block the call
PostToolUse       after any tool returns — non-blocking observer
PostEdit          after a write_file / edit_file / multi_edit /
                  notebook_edit succeeds — formatter / linter / commit
                  hooks live here
UserPromptSubmit  before a user-initiated prompt reaches the agent —
                  exit 2 to refuse the submit (e.g. block secrets)
SessionStart      once per agent boot
Stop              after the agent settles a turn — payload includes
                  the final assistant text in .finalMessage
PreCompact        before the compaction engine runs
PostCompact       after compaction — payload includes
                  .collapsedMessageCount and .truncatedTokens
SubagentStart     before dispatch_agent spawns a subagent
SubagentStop      after the subagent run completes
```

### Matcher syntax

- `undefined` or empty — match every event of that type
- `"tool"` — exact tool name
- `"toolA|toolB"` — either tool
- `"tool:pathGlob"` — tool name AND file path matches the glob
- `"*:pathGlob"` — any tool whose file path matches

Globs use `*` (no separator) and `**` (with separators), gitignore-style.

### Blocking vs async

- Default (`async: false`): the agent waits for the hook to exit
  before continuing. Exit code 2 blocks the action and the hook's
  stderr is surfaced to the model so it can self-correct.
- `async: true`: fire-and-forget. The agent doesn't wait, and a
  non-zero exit is invisible unless `CODEBASE_DEBUG=1` is set.

### Timeout

`timeout` is milliseconds; default 30000. After the timeout we send
SIGTERM and treat the hook as failed (exit code 1, "hook timed out"
in stderr). Blocking hooks that time out do NOT block the action by
default — only an actual exit-2 blocks.

### Payload schema

```ts
{
  event: HookEvent,
  workingDir: string,            // cwd the agent is running in
  toolName?: string,             // tool events
  toolArgs?: unknown,            // tool events
  filePath?: string,             // tool events that operate on a file
  userPrompt?: string,           // UserPromptSubmit
  finalMessage?: string,         // Stop
  messageCount?: number,         // Pre/PostCompact
  collapsedMessageCount?: number,// PostCompact
  truncatedTokens?: number,      // PostCompact
  subagentType?: string,         // Subagent events
  subagentPrompt?: string,       // SubagentStart
  subagentSuccess?: boolean      // SubagentStop
}
```

## SSH (remote machine access)

The agent can run shell commands on remote machines via the `ssh_exec`
tool. The host list is an allowlist managed by the user — the agent
picks a name from the enrolled set, not arbitrary `user@host` strings.

### Enrollment

```sh
# Generate a key (default Ed25519, --rsa for RSA-4096 if your
# compliance / legacy infra requires it). Passphrase-less by default
# because the agent runs non-interactively.
codebase ssh keygen staging

# Print the pubkey + a one-liner to install it on the remote.

# Register the host:
codebase ssh add staging staging.example.com --user deploy --key ~/.codebase/ssh/staging

# Verify connectivity:
codebase ssh test staging

# Inspect / remove:
codebase ssh list
codebase ssh rm staging
```

### How the agent uses it

When asked to "deploy the build to staging", the model issues:

```ts
ssh_exec({ host: "staging", command: "cd /app && systemctl restart codebase" })
```

The host argument is the registered NAME, not a hostname. The tool
resolves it against `~/.codebase/ssh.json` and (optionally) project
overrides at `<cwd>/.codebase/ssh.json`. Project entries override
user entries with the same name.

### Security model

- **Allowlist by name, not free-form.** The agent can target `staging`
  only if the user enrolled `staging`. Even with prompt injection,
  the model can't pick a destination the user didn't pre-approve.
- **Same shell-validator as the local `shell` tool.** `rm -rf /`,
  fork bombs, raw writes to `/dev/sda` etc. are blocked before the
  ssh spawn, regardless of which host they target.
- **BatchMode=yes.** Never prompts for a password. If the key isn't
  accepted, the call fails fast instead of stalling.
- **StrictHostKeyChecking=accept-new.** First connection pins the
  host key (TOFU); a later host-key mismatch refuses to connect.
- **ConnectTimeout=10s + ServerAliveInterval=30s.** Unreachable
  hosts fail in seconds, dead network paths are detected during
  long-running commands.
- **IdentitiesOnly=yes when --key given.** Predictable auth path —
  ssh doesn't fall back to other keys in the agent.

The validator is advisory, not a security boundary. Real isolation
for hostile workloads still belongs in container / sandbox
boundaries on the remote.

### Config schema (`~/.codebase/ssh.json` and `<cwd>/.codebase/ssh.json`)

```json
{
  "hosts": [
    {
      "name": "staging",
      "host": "staging.example.com",
      "user": "deploy",
      "port": 22,
      "identityFile": "~/.codebase/ssh/staging",
      "description": "staging app server (us-east-1)"
    }
  ]
}
```

`name` must match `[a-z0-9][a-z0-9_-]*`. `host` rejects anything
that looks like `user@host:port` syntax — use separate fields.

## Background shells + monitors

Long-running commands (dev servers, log tails, build watchers) go in
the background so the agent doesn't block on them. Two flavors:

### Background shell

```ts
shell({ background: true, command: "npm run dev" })
// → returns task_id "bg-3" immediately
shell_output({ task_id: "bg-3" })   // poll buffered output
shell_kill({ task_id: "bg-3" })     // terminate
```

The agent gets notified automatically when a background shell exits —
no need to poll for completion.

### Monitor (push-style line notifications)

The agent can ATTACH a monitor to a running background shell to be
notified as matching lines arrive, instead of polling. Use this for
"watch the log for ERROR" or "tell me the first time the server
prints 'Listening on'."

```ts
shell({ background: true, command: "tail -f logs/app.log" })
// → "bg-1"
monitor({
  task_id: "bg-1",
  match: "ERROR|FATAL",       // regex; default = match every line
  flags: "i",                  // default; "" for case-sensitive
  max_matches: 5,              // auto-stop after N (optional)
  note: "watching app errors"  // free-form hint
})
// → "mon-1". Now any matching line steers a system-reminder
//   into the agent mid-conversation.

monitor_stop({ monitor_id: "mon-1" })   // unregister early
```

Monitors auto-clean when the watched shell exits or when `max_matches`
is reached. The background shell itself keeps running until
`shell_kill` — `monitor_stop` only unsubscribes from notifications.

## In-flight features

- **MCP**: real MCP client support hasn't shipped (the `/mcp`
  placeholder was removed). The pi-mono roadmap will likely add this.
- **Skills**: bundled + platform-fetched skills work; local
  user skills (`~/.codebase/skills/*.md`) coming.
