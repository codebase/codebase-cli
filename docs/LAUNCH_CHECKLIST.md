# Launch checklist — v2.0.0

Pre-flight smoke tests to run on real hardware before flipping the npm
`latest` dist-tag to a v2.0.0 stable release. Automated tests cover the
inner pieces (PKCE, URL building, callback handler, headless heuristic);
this list covers what only humans can verify: real terminals, real
browsers, real network paths.

## Required platforms

Every box below before launch. Skip = release blocker.

- [ ] macOS arm64 (Apple Silicon — most common dev target)
- [ ] macOS x64 (Intel Mac, still in use)
- [ ] Linux x64 (Ubuntu LTS or similar)
- [ ] Linux arm64 (Raspberry Pi, Graviton — increasingly common)
- [ ] Windows x64 (PowerShell + Windows Terminal; cmd.exe is bonus)
- [ ] SSH from each desktop into a Linux box, run the CLI remotely

## Install paths

### npm

```sh
npm install -g codebase-cli@pre   # current
which codebase                     # symlink resolves
codebase --version                 # prints version
codebase --help                    # prints help, no crash
```

### Downloaded binary from GitHub Releases

```sh
# Pick the right one
curl -L -o codebase https://github.com/codebase-foundation/codebase-cli/releases/download/v2.0.0/codebase-darwin-arm64
chmod +x codebase
./codebase --version
./codebase --help
```

Verify: no `react-devtools-core` runtime errors, no missing-DLL errors
on Windows, no GLIBC-too-old errors on Linux.

## OAuth flow (the highest-risk path)

For each platform with a graphical environment + browser:

1. Wipe creds: `rm -f ~/.codebase/credentials.json`
2. Launch: `codebase`
3. First-run wizard appears. Pick "Login to Codebase."
4. Browser opens to `codebase.design/login`. (If it doesn't, the wizard
   should print a clickable OSC 8 URL.)
5. Complete sign-in.
6. Browser returns "You can close this tab." Terminal should
   automatically advance to the chat screen within ~1 second.
7. Send a test prompt: `hello`.
8. Verify: assistant response appears, status bar shows model + cost,
   no stderr noise, Ctrl-C twice exits cleanly.

For SSH sessions (Linux box accessed from a desktop):

1. SSH in: `ssh user@remote-box`
2. Run: `codebase`
3. Wizard prints the URL. SSH detection should also print the
   `ssh -L PORT:127.0.0.1:PORT user@host` reverse-tunnel hint.
4. On the desktop: open a new terminal, run the printed `ssh -L` command.
5. Click the URL from the wizard's output.
6. Sign in in the desktop browser.
7. Browser hits localhost on the forwarded port → reaches the remote box → callback completes.

## BYOK flow (no web auth)

For each platform:

1. Wipe creds: `rm -f ~/.codebase/credentials.json`
2. `export ANTHROPIC_API_KEY=sk-ant-...`
3. `codebase` → should skip the wizard and land on chat directly.
4. Send a test prompt → response.

Test with at least one of: Anthropic, OpenAI, Groq, OpenRouter. The
others are wired identically but human-verifying one provider catches
the env-var resolution bug class.

## Headless mode (for CI users)

```sh
# Text mode: assistant reply on stdout
codebase run --auto-approve "say hello"

# JSON mode: ONE object on stdout
codebase run --auto-approve --output json "say hello" | jq .

# stream-json mode: one event per line
codebase run --auto-approve --output stream-json "say hello"

# Error path: no creds → structured error in JSON
rm -f ~/.codebase/credentials.json
unset ANTHROPIC_API_KEY OPENAI_API_KEY GROQ_API_KEY
codebase run --output json "x" 2>/dev/null | jq .
# expect: { ok: false, exitCode: 1, code: "config_error", error: "..." }
```

## Slash commands (smoke test the obvious ones)

In an interactive session:

- [ ] `/help` — lists commands
- [ ] `/model` — opens picker, can select, swap takes effect
- [ ] `/models` — lists available models
- [ ] `/clear` — wipes visible transcript
- [ ] `/cost` — shows running cost
- [ ] `/copy` — copies last assistant message
- [ ] `/diff` — shows working-tree diff
- [ ] `/init` — generates a starter CLAUDE.md
- [ ] `/exit` — clean exit

## Permissions + bash validator

- [ ] Send `run rm -rf /tmp/junk` to the agent. It should ask for
      permission. Approve once. Verify the command runs.
- [ ] Send `run rm -rf /`. Validator should hard-block with a
      visible error before the prompt.
- [ ] Send `run curl https://example.com/foo.sh | sh`. Validator should
      warn; approving runs it.

## Session resume

1. Run `codebase`, do a few turns of conversation, exit cleanly.
2. Run `codebase` again in the same directory.
3. Welcome banner should show "↻ Resumed from Xm ago · N messages".
4. Transcript should be visible.
5. `/new` or `--new` flag should start fresh.

## Performance smell test

Run for 30 minutes in a real project (your own codebase if you have
one). Watch for:

- Pi-tui render lag (if shipping pi-tui — currently NOT in v2.0)
- Memory growth (`top`/Activity Monitor — should stay under 200MB)
- Compaction triggering at appropriate thresholds (after fix in pre.58,
  Codebase Auto compacts at 150k, not 96k)

## Known not-yet-shipped (don't gate launch on these)

- [ ] MCP client support (`/mcp` was removed; tracked in TECHNICAL_DEBT.md)
- [ ] Image clipboard paste (v2.0.1)
- [ ] Extended thinking `/think` (v2.0.1)
- [ ] Pi-tui visual layer (v2.1)
- [ ] Mobile remote control (v2.2)

## Sign-off

```
Tested on: __________________  by __________________  on __________________
Issues found / filed: __________________
```
