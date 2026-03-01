# Codebase CLI

AI coding agent that runs in your terminal. Reads your project, writes code, runs commands — using any OpenAI-compatible LLM.

## Install

```sh
curl -sSL https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.sh | sh
```

Or with Go:

```sh
go install github.com/codebase-foundation/cli@latest
```

Or build from source:

```sh
git clone https://github.com/codebase-foundation/codebase-cli.git
cd codebase-cli
go build -o codebase .
```

## Quick Start

```sh
export OPENAI_API_KEY=sk-...
cd your-project
codebase
```

Works with any OpenAI-compatible API:

```sh
# Groq
export OPENAI_BASE_URL=https://api.groq.com/openai/v1
export OPENAI_API_KEY=gsk-...
export OPENAI_MODEL=llama-3.3-70b-versatile

# Ollama (local)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
export OPENAI_MODEL=qwen2.5-coder:32b

# Any OpenAI-compatible endpoint
export OPENAI_BASE_URL=https://your-provider.com/v1
export OPENAI_API_KEY=your-key
export OPENAI_MODEL=your-model

codebase
```

## Tools

The agent has 9 built-in tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers |
| `write_file` | Create or overwrite files |
| `edit_file` | Surgical find-and-replace |
| `multi_edit` | Batch edits across multiple files |
| `list_files` | Directory listing and glob search |
| `search_files` | Regex search across codebase (ripgrep) |
| `web_search` | Search the web (Tavily, Brave, SearXNG, or DuckDuckGo) |
| `dispatch_agent` | Spawn a read-only research subagent |
| `shell` | Run any shell command |

Read-only tools run in parallel automatically.

## Web Search

Web search works out of the box with DuckDuckGo (no API key needed). For better results, configure a provider:

```sh
# Tavily (recommended for AI agents)
export TAVILY_API_KEY=tvly-...

# Brave Search
export BRAVE_API_KEY=BSA...

# Self-hosted SearXNG
export SEARXNG_URL=https://your-searxng-instance.com
```

## Glue Models (Optional)

Route cheap tasks (intent classification, titles, narration) to a separate fast/small model while keeping your main agent on a smarter model:

```sh
export GLUE_API_KEY=gsk-...
export GLUE_BASE_URL=https://api.groq.com/openai/v1
export GLUE_FAST_MODEL=llama-3.1-8b-instant
export GLUE_SMART_MODEL=llama-3.3-70b-versatile
```

If not set, glue falls back to your main `OPENAI_*` config.

## Features

- **Demoscene boot screen** — plasma, 3D cube, sine scroller, chiptune audio
- **Streaming responses** — real-time token output as the model thinks
- **Agentic loop** — multi-turn tool use with automatic continuation
- **Parallel tool execution** — read-only tools run concurrently
- **Conversation compaction** — automatic context management for long sessions
- **Session persistence** — resume where you left off
- **Project awareness** — reads AGENTS.md/CLAUDE.md/CODEX.md for project instructions
- **Planning mode** — Glue-driven Q&A for complex tasks before building
- **Intent routing** — chat, clarify, plan, or build based on your message
- **Subagent dispatch** — spawn isolated research agents for deep dives

## Flags

```
-model      LLM model name (default: gpt-4o)
-base-url   OpenAI-compatible API base URL
-dir        Working directory (default: current directory)
-version    Print version and exit
```

## License

MIT
