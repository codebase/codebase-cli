<p align="center">
  <img src="docs/assets/codebase-mark.svg" alt="codebase" width="96" />
</p>

<h1 align="center">codebase</h1>

<p align="center">
  <strong>An AI coding agent for builders.</strong><br/>
  Lives in your terminal. Reads your project, writes code, runs commands, ships work.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codebase-cli"><img alt="npm" src="https://img.shields.io/npm/v/codebase-cli?style=flat-square" /></a>
  <a href="https://github.com/codebase-foundation/codebase-cli/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  <strong>Powered by <a href="https://github.com/earendil-works/pi">pi</a></strong> &nbsp;·&nbsp;
  <em>The agent loop, provider adapters, and session protocol come from <a href="https://github.com/earendil-works/pi">pi-mono</a>.</em>
</p>

---

## Two ways to run it

**Bring your own LLM.** Drop an API key in your shell and go — Anthropic, OpenAI, Groq, OpenRouter, Mistral, Ollama, any OpenAI-compatible endpoint.

```sh
ANTHROPIC_API_KEY=sk-ant-... codebase
# or
OPENAI_API_KEY=sk-... codebase
```

**Sign in to [codebase.design](https://codebase.design) and skip key wrangling.** One auth, every model.

- **Free tier** — try open-weight models (MiniMax, Qwen, Llama, etc.) with a **10-turn taste** so you can kick the tires before paying anyone for anything. No API keys to set up.
- **Paid account** — uncaps the open-weights, adds the frontier models (Claude Opus / Sonnet, GPT-5, …), higher rate limits, and longer context windows. One subscription replaces N provider bills.

```sh
codebase auth login
codebase
```

Switch between models any time with `/model` (interactive picker) or `/model <id>`.

## Install

Requires **Node.js ≥ 20**.

```sh
# one-liner (macOS / Linux)
curl -fsSL https://codebase.design/install.sh | sh

# Windows (PowerShell)
irm https://codebase.design/install.ps1 | iex

# any platform
npm i -g codebase-cli
```

## Quick start

```sh
cd your-project
codebase
```

Type. Hit enter. The agent reads files, runs tests, edits code, and shows you what it did. Slash `/help` for the rest.

A few things worth knowing:

- `/model` — pick a model interactively, live list of what your account can hit
- `/plan` — Q&A before the agent touches anything
- `!cmd` — run a shell command without spending a turn
- `@path` — pin a file into the next prompt
- `\<Enter>` — multi-line input
- **Type while the agent is working** — your prompt queues, fires when the current turn ends (`Ctrl-C` while busy clears the queue along with the turn)
- **Ctrl-C** stops the current turn, twice fast exits

## What it does

- **Streaming responses.** Real-time token output, coalesced to 60 fps so the TUI doesn't thrash.
- **Multi-turn agentic loop.** Tool call → result → next turn, automatically.
- **Parallel tool execution.** Read-only tools (grep, glob, read, git status…) run concurrently within a turn.
- **Project awareness.** Auto-loads `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, or `.cursorrules` from the project root into the system prompt.
- **Conversation compaction.** Long sessions automatically summarize older turns to stay under the context window.
- **Session persistence.** Auto-resume from where you left off; `--new` for a clean slate.
- **Plan mode.** A cheap-model Q&A pass surfaces the right plan before the expensive agent starts editing.
- **Intent routing.** Chit-chat doesn't burn a full agent turn; complex asks roll into plan mode automatically.
- **Subagent dispatch.** Spawn isolated research agents that keep their tool noise out of your main context.

## Builder-focused defaults

- **Any LLM**, not just Anthropic. Provider choice is config.
- **45+ tools** behind one small interface — adding one is mechanical.
- **Effect-based permissions** instead of tool-name allowlists.
- **Single immutable state** driven by a typed reducer — the UI is one render of one value.
- **Multi-process safe OAuth** with lockfile-coordinated token refresh — run 10 instances of codebase at once and they share a single refresh per hour.
- **Plain `npm i -g`**, no bundler lock-in.

## More

- [`.settings/`](.settings/) — orientation: tenets, architecture, extending, testing
- [`CLAUDE.md`](CLAUDE.md) — quick reference for AI agents working in this repo
- [`docs/MIGRATION_v1_to_v2.md`](docs/MIGRATION_v1_to_v2.md) — upgrading from the Go v1 binary
- `/help` inside the CLI — every slash command and shortcut

## License

MIT. Built on [pi-mono](https://github.com/earendil-works/pi) (MIT).
