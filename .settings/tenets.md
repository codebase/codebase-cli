# Tenets

These are decisions, not aspirations — the code already reflects them.
When in doubt, the tenet wins over momentum. When two tenets conflict,
they're listed roughly in priority order.

## 1. Better than Claude Code, not a clone

We study Claude Code's source as a benchmark for feature coverage and learn
from their architectural mistakes. Every feature we add should be a *better*
implementation, not a copy-paste. We have CC's source for reference; what we
copy is the *idea* (collapsed read groups, tool-status spinners, `!cmd` shell
escape), never the wording or the data structures.

**Why this matters**: this is open source. Verbatim copies of CC's prompt
strings or code create IP risk. The technique is fine; the specific words
must be original.

## 2. Any LLM provider, never lock-in

OAuth login for our hosted offering, BYOK for everything else. Anthropic,
OpenAI, Groq, OpenRouter, Ollama, anything OpenAI-compatible. Provider
choice is config; the agent loop is provider-agnostic because pi-ai
abstracts the protocol differences.

**Implication**: don't write code that assumes a specific provider's quirks
unless you also write the fallback path. Don't depend on provider-specific
features (e.g. Anthropic's tool_use blocks) outside of the protocol adapter
layer in `@earendil-works/pi-ai`.

## 3. Simplicity beats features

CC is 512K LOC. We're ~22K. That's not an accident — it's a position. Before
adding a feature, ask: "is this *the* feature, or *a* feature?" Most of CC's
features are accretion. Most ours should not be.

**Practical rules**:
- No premature abstraction. Three similar lines is better than a wrong helper.
- No backwards-compat shims for code you're rewriting in the same PR.
- No "let's make this configurable" before there's a second use case.
- Comments explain *why*, not *what*. Default to none.

## 4. Effect-based permissions

Tools declare their **effects** (`reads_fs`, `writes_fs`, `runs_shell`,
`network`). Permission policies match on effects, not tool names. Adding a
new tool = declaring its effects; the permission system already knows what
to do. CC has 300K+ lines of permission AST parsing for tool-name patterns;
we have ~600 lines because we made the foundational call differently.

Don't add tool-name special-cases to the permission engine. If a real
restriction needs to exist, it's a new effect.

## 5. Streaming is a UX commitment

Models emit tokens at 60-100 Hz. Tools emit stdout in bursts. The TUI has
to keep up *without* repainting at that rate or it'll thrash the user's
terminal. We coalesce to 16ms (60fps) in `use-coalesced-agent-events.ts`.

If you're adding a state path the streaming pipeline goes through, ask:
"does this allocate on every event?" Often the answer is "we make a new Map
per update" — and that's *fine* because the reducer microbenchmark
(`npm run bench:micro`) says we have 10M+ events/sec of headroom. But
don't add work without checking.

## 6. The agent loop belongs to pi-mono

`@earendil-works/pi-agent-core` owns: the model.run() loop, message
shape, tool-call protocol, session persistence. We do not reimplement
those primitives. When something in the loop misbehaves, the fix is
upstream in pi-mono unless we're misusing it.

Things we own: the TUI, tools, slash commands, permissions, the glue
sidecar, OAuth, the wizard, the headless `run` subcommand, the JSON-RPC
`app-server`.

## 7. Test the load-bearing parts

Tools, the reducer, the router, parsers, and credential handling have
unit tests. The interactive TUI does not — yet. We accept the trade-off:
the parts most likely to silently break (filesystem ops, permissions,
auth flows, state transitions) are covered; the rendering layer is
covered by manual smoke testing during development. If you're touching
something with no tests, *that's* the thing to test before refactoring it.

The faux provider from pi-ai (`registerFauxProvider`) is the right tool
for E2E tests — see `src/agent/__test__/agent-e2e.test.ts`. No mocks, real
agent loop, deterministic.

## 8. Don't fight the user's terminal

Setting raw mode? Restore it on every exit path, including uncaught
exceptions. Setting the terminal title? Use OSC 0 and accept that
non-TTYs won't see it. Hiding the cursor? Show it back on unmount.
See `src/ui/terminal-restore.ts`. The user's `stty sane` recovery
moments are user-trust-destroying — we don't get to have those.

## 9. Don't commit aspirations

Per `CLAUDE.md` §2.4: never commit specs, governance docs, or policy
files for systems that do not yet exist. This `.settings/` folder
describes what's *in the code today*, not what we'd like to build.
If we add a feature, the docs follow the code — not the other way.

## 10. Ship something you'd use

The author runs this in production for daily development. Bugs that
annoy us get fixed first. Features no one uses get deleted. This is a
tool first, a product second.
