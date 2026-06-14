<h1 align="center">codebase</h1>

<p align="center">
  <strong>An AI coding agent that lives in your terminal.</strong><br/>
  Any LLM. Reads your project, writes code, runs commands, ships work.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codebase-cli"><img alt="npm" src="https://img.shields.io/npm/v/codebase-cli?style=flat-square" /></a>
  <a href="https://github.com/codebase-foundation/codebase-cli/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

## Install

Requires **Node.js ≥ 20**.

```sh
# macOS / Linux
curl -fsSL https://codebase.design/install.sh | sh

# Windows (PowerShell)
irm https://codebase.design/install.ps1 | iex

# any platform, with npm
npm i -g codebase-cli
```

Then, in any project:

```sh
cd your-project
codebase
```

Type, hit enter. It reads files, edits code, runs tests, and shows its work. `/help` lists everything.

## Pick your LLM

**Bring your own key** — Anthropic, OpenAI, Groq, OpenRouter, Mistral, Ollama, or any OpenAI-compatible endpoint:

```sh
ANTHROPIC_API_KEY=sk-ant-... codebase     # or OPENAI_API_KEY, GROQ_API_KEY, …
```

**Or sign in once** and skip the key wrangling — [codebase.design](https://codebase.design) gives you a free taste of open-weight models, and a paid account uncaps those plus the frontier models (Claude Opus/Sonnet, GPT-5, …) behind one bill. First run walks you through it; it even auto-detects a local LLM (LM Studio / Ollama / vLLM).

```sh
codebase auth login
```

Swap models live with `/model`. Set reasoning depth with `/effort`.

## What makes it good

- **🏁 Tournaments.** `/tournament <task>` races several agents on the same change in isolated worktrees, a judge ranks them, you merge the winner. `--models opus,sonnet,haiku` pits models head-to-head on *your* code.
- **↺ Rewind anything.** `/rewind` rolls the conversation *and* the files back to before any earlier prompt — a bad turn fully un-happens. Every edit is checkpointed.
- **🧠 Remembers across sessions.** Pulls durable facts (your prefs, project decisions, the rules you set) out of a session in the background so the next one starts informed. `#note` to add one by hand.
- **🔌 MCP.** Connect external tool servers (filesystem, Postgres, git, fetch, …) over stdio or remote HTTP, OAuth and all. Their tools splice straight into the agent.
- **🤖 Subagents.** Fan out read-only researchers or write-capable workers that keep their tool-noise out of your main context — each can run in its own git worktree, on its own model and reasoning level.
- **🪝 Hooks.** Shell commands on lifecycle events (pre/post tool, edit, prompt, session start/end) — run a formatter on save, block secrets, commit on exit.
- **🌐 SSH.** Run commands on enrolled remote hosts by name, behind the same safety validator as the local shell.

…plus a fast differential TUI (clean copy-mode with `Ctrl-O`, image paste with `Ctrl-V`, history search with `Ctrl-R`, `$EDITOR` compose with `Ctrl-G`), **plan mode** for a cheap Q&A pass before editing, **auto-compaction** of long sessions, **multi-session resume** (`/resume`, `/rename`, `/tag`), **skills** & **output styles** as drop-in markdown, **45+ tools** behind one interface, and **effect-based permissions** you can teach with `/permissions`.

## Cheat sheet

```
/model /effort /plan /tournament /rewind /resume /permissions /mcp /agents /help
!cmd     run a shell command without spending a turn
@path    pin a file into the next prompt
#note    save a memory   ·   \<Enter>  multi-line   ·   Ctrl-C  stop turn / exit
```

Type while it's working — your prompt queues and fires when the turn ends.

## Built on pi

The agent loop, provider adapters, and session protocol come from
**[pi](https://github.com/earendil-works/pi)** (MIT). Go give them a star.

## More

- [`CLAUDE.md`](CLAUDE.md) — full feature reference
- [`.settings/`](.settings/) — tenets, architecture, extending, testing
- [`docs/MIGRATION_v1_to_v2.md`](docs/MIGRATION_v1_to_v2.md) — upgrading from the Go v1 binary
- `/help` inside the CLI — every command and shortcut

## License

MIT.
