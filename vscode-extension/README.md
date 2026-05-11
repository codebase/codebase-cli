# Codebase — VS Code / Cursor / Windsurf extension

A sidebar chat panel powered by [codebase-cli](https://github.com/codebase-foundation/codebase-cli).
Spawns `codebase app-server` as a child process and renders the agent's
events into a webview. Works in any VS Code-API-compatible editor —
verified in **VS Code**, **Cursor**, and **Windsurf**.

## Prerequisites

Install the CLI globally (Node ≥ 20):

```sh
curl -fsSL https://codebase.design/install.sh | sh
# or
npm install -g codebase-cli
```

Then sign in OR set an API key:

```sh
codebase auth login              # OAuth via codebase.design
# OR
export ANTHROPIC_API_KEY=sk-…    # Anthropic / OpenAI / Groq / etc.
# OR
export OPENAI_API_KEY=… OPENAI_BASE_URL=https://your-llm/v1 OPENAI_MODEL=…
```

The extension picks whatever provider config the CLI itself would
auto-detect — env vars, saved credentials, or the openai-compat path.

## Install the extension

From source (until we publish to the marketplace):

```sh
cd vscode-extension
npm install
npm run package
# → produces codebase-0.1.0.vsix

code --install-extension codebase-0.1.0.vsix
# or in Cursor:
cursor --install-extension codebase-0.1.0.vsix
# or in Windsurf:
windsurf --install-extension codebase-0.1.0.vsix
```

Restart the editor, open the **Codebase** icon in the activity bar (left rail), type a prompt.

## What's in this build

- **Streaming responses** in a sidebar webview
- **Tool calls** rendered inline with a status indicator
- **Permission prompts** when the agent wants to write/run shell — choose Allow / Trust tool / Trust all / Deny
- **Abort** mid-run via the Abort button or the `Codebase: Abort current run` command
- **Auto-resume** the previous session for the workspace (toggle in settings)
- **Restart** via the `Codebase: Restart agent` command
- **Output channel** ("Codebase" in Output panel) shows the CLI's stderr for debugging

## Configuration

| Setting | Default | What |
|---|---|---|
| `codebase.binaryPath` | `codebase` | Path to the CLI. Set if it's not on PATH. |
| `codebase.resume` | `true` | Resume the previous session for this workspace. |

## Commands

| Command | What |
|---|---|
| `Codebase: Ask` | Focus the chat input (keyboard-friendly entry point) |
| `Codebase: Abort current run` | Stop the in-flight agent turn |
| `Codebase: Restart agent` | Kill and restart `codebase app-server` for this workspace |

## Protocol

The extension talks to the CLI via newline-delimited JSON over stdio.
The schema is in [`src/app-server/protocol.ts`](../src/app-server/protocol.ts)
in the codebase-cli repo — mirrored inline in [`src/rpcClient.ts`](src/rpcClient.ts).

If you want to drive the same protocol from another tool (a different
IDE, a script, a curl), spawn:

```sh
codebase app-server
```

…and send commands like:

```json
{"id":"1","type":"initialize","clientInfo":{"name":"my-tool","version":"0.1.0"}}
{"id":"2","type":"prompt","message":"fix the typo in src/index.ts"}
```

You'll get events streamed back as JSONL. See the codebase-cli README
for the full command list.

## Development

```sh
cd vscode-extension
npm install
npm run compile         # tsc → out/
# Then F5 in VS Code (with the extension folder open) to launch
# an Extension Development Host with the extension loaded.
```

## Known limitations

- **No image input yet** — the protocol supports it, the webview doesn't.
- **No `set_model` mid-session** — pick the model at startup via env vars.
- **No diff viewer** — file edits show as a tool call line; open the file to see the change.
- **Auto-approve by default** — the extension currently auto-approves
  permission prompts on the CLI side. Pass `--no-auto-approve` to the
  CLI invocation to require approval through the webview (planned: a
  setting to toggle this).

## License

MIT, same as codebase-cli.
