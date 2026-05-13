# Extending the CLI

How to add the three most common things. Patterns are stable; if you need to
deviate, find an existing example first and follow it.

## Add a tool

Tools are self-contained modules in `src/tools/`. Each one exports a `Tool`
that the agent registry picks up. The canonical small example is
`src/tools/glob.ts`. Copy its shape:

```ts
// src/tools/my-tool.ts
import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";

export const myTool: Tool = {
  name: "my_tool",
  description: "One-line summary the model sees. Be specific; this drives selection.",
  parameters: Type.Object({
    target: Type.String({ description: "What to operate on" }),
    mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("safe")])),
  }),
  effects: ["reads_fs"], // or ["writes_fs"], ["runs_shell"], ["network"]
  execute: async (args, ctx) => {
    // ctx.cwd, ctx.permissions, ctx.abortSignal, ctx.tasks, ctx.fileStateCache
    // Return a string (default), or { content, isError } for richer outputs.
    return "result string";
  },
};
```

Then register it in `src/tools/registry.ts` (alphabetical, please):

```ts
import { myTool } from "./my-tool.js";
// ...
export const BUILTIN_TOOLS = [
  // ...
  myTool,
];
```

**Test it.** Drop `src/tools/my-tool.test.ts` next to the source. Use
`makeToolContext` from `src/tools/__test__/mock-tool-context.ts` for the
context fixture — don't hand-roll `{} as any`. Vitest convention is
`describe(toolName, () => { ... })`.

**Display polish.** Add a present-tense + past-tense label in
`src/ui/tool-labels.ts`:

```ts
// In toolActionLabel:
case "my_tool":
  return `Doing ${displayPath(str("target"))}`;
// In toolActionPast:
case "my_tool":
  return `Did ${displayPath(str("target"))}`;
```

If your tool reads files and produces deterministic small output that
collapses well in runs, add it to `COLLAPSIBLE_READ_TOOLS` in
`src/ui/tool-call-line.tsx`.

## Add a slash command

Commands live in `src/commands/builtins.ts`. Add one:

```ts
const myCommand: Command = {
  name: "my-thing",
  aliases: ["mt"],
  description: "What this does, ≤ 60 chars — shown in /help.",
  // mutates: true,  // only if it changes session state (clear, compact)
  handler: async (args, ctx) => {
    // ctx.bundle, ctx.state, ctx.emit, ctx.clearDisplay, ctx.exit, ctx.registry
    ctx.emit("did the thing");
    return { handled: true };
  },
};
```

Then add it to `BUILTIN_COMMANDS` (alphabetical). The registry handles
parsing, dispatch, unknown-command typo suggestions, and the help listing.

Slash commands that need to render persistent assistant-style messages
should call `bundle.appendSyntheticAssistantMessage(...)` (TODO: check the
exact name in `src/agent/agent.ts`) rather than `emit()`, which is for
short status lines.

**Test it.** `src/commands/registry.test.ts` shows the pattern. Use
`fakeCtx()` to construct the context; only fill the fields your handler
reads.

## Add an LLM provider

The agent never talks to a provider directly — `@earendil-works/pi-ai`
does. If the provider has an OpenAI-compatible API, you usually don't need
to add anything: users set `OPENAI_BASE_URL` + `OPENAI_API_KEY` and the
existing path handles it.

For a provider that needs a new protocol adapter, the work lives upstream
in pi-ai, not here. Open an issue / PR on `@earendil-works/pi-ai` first;
once it lands, expose it in our config layer:

- Add a model entry to `src/config/models.ts` (look for the existing
  Groq / Anthropic / OpenRouter entries as templates).
- Add credential resolution to `src/auth/credentials.ts` if it needs
  a non-standard env var or OAuth flow.
- Add provider-specific display tweaks (icon, label, etc.) if the
  default rendering looks off.

The first-run wizard (`src/ui/FirstRunSetup.tsx`) auto-detects available
provider credentials and offers them as options — no hardcoded provider
list to maintain in the wizard.

## Add a permission policy

Effect-based, not tool-name-based. Policies live in
`src/permissions/policies.ts`. To pre-approve a category:

```ts
{
  match: (req) => req.effects.includes("reads_fs") && isInsideCwd(req.args.path),
  decision: "allow",
  reason: "read-only access inside cwd is auto-approved",
}
```

To pre-deny:

```ts
{
  match: (req) => req.effects.includes("runs_shell") && isDangerous(req.args.command),
  decision: "deny",
  reason: "dangerous shell command",
}
```

The store evaluates policies in order until one matches; otherwise the
user is prompted.

## Add a glue task

Glue is the cheap/fast sidecar model. Routing, narration, plan-mode Q&A,
prompt suggestions all live here.

A glue call should:
- Have a graceful fallback when the glue model is unconfigured or fails.
- Be cheap to abort — wrap the network call with `AbortController`.
- Never feed its output into the main agent's context. Glue is for *UI
  enrichment*, not agent reasoning.

The pattern in `src/agent/prompt-suggestion.ts` is the template: small
prompt, abort signal threaded through, silent failure mode.

## Add a microbenchmark

If you're touching a hot path (reducer, coalesce, diff, wrap), add a bench
case to `src/agent/events.bench.ts` (or a peer `*.bench.ts` file).
`npm run bench:micro` runs them. They're not part of `npm test` so they
don't slow CI — but they give us a baseline number to spot regressions.

## What NOT to extend

- **Don't add a new chat-state field unless every reducer branch handles it.**
  ChatState is the single source of truth for what the UI shows; partial
  fields produce mysterious render bugs.
- **Don't reach into pi-agent-core's internals.** If you need something the
  public API doesn't give you, the fix is upstream.
- **Don't add a separate persistence file format for new state.** Sessions,
  history, memory, credentials, and tasks each have one canonical JSON
  schema. Add fields, don't add sidecars.
