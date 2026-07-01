# Codebase CLI Dogfood Notes - 2026-07-01

Scope: make the OSS CLI easy to find, install, run, configure, and then use for a first real coding task.

Branch tested: `origin/main` at `505cf9f` (`docs(dox): add repository guidance`), in a clean worktree at `/Users/j/Documents/New project/codebase-cli-dogfood`.

## Executive Read

The actual CLI onboarding is close: a clean first run with no credentials opens a clear provider chooser, the browser OAuth path works end-to-end against `codebase.design`, the BYOK path explains where credentials are stored, and local package install plus the built binary smoke tests work.

The launch funnel around the CLI needs tightening before a broad web launch. The biggest issues are discoverability and trust: npm registry metadata currently has an empty README body, the public web Downloads page does not visibly surface the CLI install path, and the homepage "View Source" CTA points users away from the CLI repo. Once installed, invalid credential errors are too raw for first-time users.

## What I Ran

- `git fetch origin`
- `git ls-remote --heads origin`
- `npm ci`
- `npm run check`
- `npm run build`
- `npm pack --dry-run`
- `npm install --prefix <tmp> .` then `<tmp>/node_modules/.bin/codebase --version` and `--help`
- Fresh HOME smoke tests:
  - `codebase auth status`
  - `codebase project list`
  - `codebase auth refresh`
  - `codebase run --output json "say hi"`
  - interactive `codebase --new` first-run wizard
  - first-run "Login to Codebase" browser OAuth from a clean `HOME`
  - authenticated interactive TUI app-build prompt
  - authenticated `codebase run --auto-approve --output text "<counter app prompt>"`
  - authenticated `codebase auto --output json "Reply with exactly READY..."`
  - authenticated `codebase auto --output json "<tiny static app prompt>"`
  - `codebase auth --help`, `codebase project --help`, `codebase run --help`
  - authenticated `project list` and `project pull <id> <dest>`
  - `codebase doctor` from a fresh temp `HOME`
  - `codebase project list --limit 5`
  - `codebase project pull <id> <dest>` with spaces in the destination path
  - headless no-credentials JSON/stream-json failure modes
  - fake provider-key save attempt (`codebase auth sk-ant-...`)
  - fake manual token runtime failure
  - headless without `--auto-approve` on a write task
  - real temp git repo edit: change one line, run `npm test`, inspect `git diff`
  - interactive `/diff`, `/help`, and `/exit`
- Registry/public checks:
  - `npm view codebase-cli version dist-tags bin engines repository homepage description --json`
  - registry `codebase-cli/latest` JSON
  - `npm pack codebase-cli@latest`
  - `https://codebase.design`
  - `https://codebase.design/downloads`
  - `https://github.com/codebase-foundation/codebase-cli`

## Fixed In This Branch

- `npm run check` failed on latest `origin/main`. It is now green.
- `grep` tool with ripgrep no longer searches standard dependency/build dirs such as `node_modules`, matching the documented tool contract and the fallback `grep` behavior.
- Hook cwd test now compares canonical realpaths, avoiding macOS `/var` versus `/private/var` temp path flakes.
- Cleaned lint blockers: unused imports/vars and string concatenation style warnings.
- Top-level help now says `codebase auth login` uses `codebase.design` browser OAuth, matching the actual first-run path.
- Install scripts now say "free Codebase credits" instead of "free Claude usage."
- The pi TUI live tool panel no longer crashes on an 80-column terminal when a `write_file` preview includes multiline content such as HTML.
- `codebase auth --help`, `codebase project --help`, and `codebase run --help` now show useful help instead of erroring or attempting provider setup.
- Headless provider/auth failures now exit non-zero. A bad saved token previously produced `ok: true`, `exitCode: 0`, and an empty final answer despite `401 "invalid_token"` inside the assistant message.
- Headless runs without `--auto-approve` now fail explicitly with `code: "approval_required"` instead of returning empty success while a write tool waits for an approval UI that does not exist.
- `codebase auth sk-ant-...` now rejects provider-looking API keys with a BYOK recovery hint instead of saving them as Codebase proxy tokens.
- Added top-level `codebase doctor`, sharing the same health-report core as interactive `/doctor`, so stuck users can diagnose runtime/auth/config/storage before the TUI starts.
- `codebase project list` now defaults to 25 entries, supports `--limit N` / `--all`, and sorts indexed/titled projects before raw storage-only entries.
- `codebase project pull` now prints a quoted unzip command that extracts beside the downloaded ZIP, including when the destination path contains spaces.
- Added `codebase auto <prompt>` as a discoverable shortcut for `codebase run --auto-approve <prompt>`, including help text and JSON/stream-json output support.
- CLI OAuth sessions now pin Codebase Auto metadata to the backend `codebase/d4f` route and use the backend registry's `131072` context window instead of an optimistic `200000`.
- First-run setup copy now fits an 80-column terminal and tells users the actual recovery paths: `/model`, `auth login`, or `--new`.

Verification after fixes:

- `npx vitest --run src/mcp/oauth/token.test.ts src/tools/grep.test.ts src/hooks/runner.test.ts`
- `npm run lint`
- `npm run check`
- `npm run build`
- `npx vitest --run src/ui-pi/tool-panel-live.test.ts`
- `npx vitest --run src/auth/cli.test.ts src/projects/cli.test.ts src/headless/run.test.ts src/agent/config.test.ts`
- Authenticated dogfood: first-run OAuth saved credentials at mode `0600`, `codebase auth status` reported scopes `inference projects credits`, and `codebase run --auto-approve` created `index.html`, `styles.css`, and `app.js` in a fresh temp workspace.
- Authenticated scenario pass: `codebase run --auto-approve` edited only `app.js` in a temp git repo, ran `npm test`, and left the expected one-line diff; interactive `/diff` rendered the same hunk.
- Authenticated `codebase auto --output json "Reply with exactly READY..."` exited `0` and reported `model: { provider: "codebase", id: "d4f", name: "Codebase Auto" }`, `source: "proxy"`.
- Authenticated `codebase auto --output json "<tiny static app prompt>"` exited `0`, produced `index.html`, `styles.css`, and `app.js`, and the generated app rendered over localhost; clicking "Mark All Done" checked all three boxes and changed the button to "Reset All".
- Fresh no-credentials `codebase auto --output json "make a file"` exited `1` with `code: "config_error"`, which is good for automation but still dense for a human first run.
- Reopened the first-run wizard at 80 columns. The top-level menu now renders without clipping: "Login to Codebase" shows "free credits · Codebase Auto", and BYOK shows "provider key or local endpoint."

## Browser OAuth + Build E2E - 2026-07-01

Path tested:

1. Built latest CLI from `origin/main` branch.
2. Launched the real package entrypoint, `bin/codebase`, with a clean temp `HOME`.
3. First-run wizard highlighted "Login to Codebase" by default.
4. Pressing Enter opened Chrome to `https://codebase.design/login?...`.
5. Browser landed on the local callback success page: "Signed in. You can close this tab."
6. CLI entered the signed-in TUI and showed `signed in via codebase.design`.
7. `codebase auth status` in the same temp `HOME` reported `signed in via codebase`, scopes `inference projects credits`, and credential file mode `600`.
8. `codebase run --auto-approve --output text "Build a tiny static counter app..."` exited `0` and created the requested files.

Files produced by the headless build:

- `/tmp/codebase-dogfood-headless.eiw0Hj/index.html`
- `/tmp/codebase-dogfood-headless.eiw0Hj/styles.css`
- `/tmp/codebase-dogfood-headless.eiw0Hj/app.js`

Interactive TUI note: the first authenticated TUI build attempt found a real crash before the fix above:

```text
uncaught exception: Error: Rendered line 22 exceeds terminal width (87 > 80).
```

Cause: the sticky live tool-call panel rendered a multiline `write_file` argument preview as one line. The fix sanitizes preview newlines and clamps ANSI strings to terminal width. After the fix, the same TUI flow no longer crashed. It still required one approval per `write_file` call when choosing "Allow once"; for a first app build, nudging users toward "Trust tool" or batching writes would make the happy path feel smoother.

## Web Launch UX Pass - 2026-07-01

Path tested:

1. Built the companion web branch with `npm run build`.
2. Started local production Next with explicit localhost env overrides because encrypted production env placeholders cannot decrypt in this checkout.
3. Checked `/cli` on desktop and mobile in the in-app browser.
4. Checked `/downloads#cli` on desktop in the in-app browser.

What looks good now:

- `/cli` has a clear first viewport: the headline says "Build apps with AI from your terminal", the macOS/Linux, npm, and PowerShell install commands are visible, and CTAs go to the CLI source and all install options.
- `/downloads#cli` now has a first-class CLI card with the same three install commands, a direct CLI source link, and a CLI quickstart link.
- The marketing header no longer shows Pricing twice. The right-side public CTA is now "Open app" and points to `/workspace`.
- Install commands on `/cli` and `/downloads#cli` now have copy buttons. On mobile, the long curl command stays on one horizontal line instead of breaking awkwardly after the pipe.
- `npm run start:production` no longer fails because `dotenvx` is missing. SEO base URL helpers also ignore undecrypted `encrypted:` placeholders instead of trying to construct malformed canonical URLs.

Still not great from a user seat:

- The analytics consent bar covers the lower install command stack on mobile and the next row of cards on desktop. It does not block the primary curl copy button, but it makes the launch pages feel more cramped than they should.
- Local `start:production` still needs explicit safe env overrides without the dotenvx private key. Otherwise other auth/env consumers can still choke on undecrypted placeholders. This is more of a contributor/devops UX issue than an end-user launch blocker.
- The no-credentials JSON failure mode is structurally correct but not friendly copy. For human terminal output, a direct "run codebase auth login or codebase --new" message would feel better.

## Launch Funnel Notes

### P0 - npm README is blank in registry metadata

Evidence:

- `npm view codebase-cli readme` returns empty output.
- Registry JSON for `codebase-cli/latest` reports `readmeLength: 0`.
- The published tarball does contain `package/README.md`, and extracting it shows the expected install docs.

Impact: npm package discovery/trust is much weaker than GitHub. A user landing on npm may see little or no README even though the package itself contains one.

Suggested fix: republish after confirming npm receives README metadata. If it remains blank, test whether the publish workflow, npm provenance path, or package metadata is suppressing readme ingestion. Add a release smoke step that asserts registry `readme.length > 500` after publish/promotion.

### P0 - Web discovery does not make the CLI obvious enough

Evidence:

- Homepage hero has "View Source", but deployed HTML points to `https://github.com/codebase-design/codebase`, not the CLI repo.
- Downloads page focuses on desktop, mobile, browser extension, and API/SKILLS.md. It does not give the CLI a first-class "Install the terminal agent" card even though the README has a good curl/npm path.
- GitHub repo About section says "No description, website, or topics provided."

Fixed in companion web branch: `/cli` now shows real install commands, `/downloads#cli` has a first-class CLI card, and the homepage hero source CTA points to `https://github.com/codebase-foundation/codebase-cli`.

Also fixed in companion web branch: `npm run build` now regenerates backend tRPC declarations before the Next production build. A fresh install initially failed because the frontend imported `backend/dist/trpc/routers/index.js` before that generated tree existed; after wiring `npm run build:trpc` into the build scripts, the production build passes.

Also fixed in companion web branch after mobile dogfood: CLI install command cards now include copy buttons on `/cli` and `/downloads#cli`, and the right-side marketing header CTA points to `/workspace` instead of duplicating Pricing.

Impact: someone excited by `codebase.design` can miss the OSS CLI entirely, or fail to connect the web product with the terminal product.

Suggested fix:

- Add a first-viewport or Downloads-page CLI card:
  - macOS/Linux: `curl -fsSL https://codebase.design/install.sh | sh`
  - Windows: `irm https://codebase.design/install.ps1 | iex`
  - npm: `npm i -g codebase-cli`
- Make "View Source" point directly to `https://github.com/codebase-foundation/codebase-cli` or label it as platform/web source if it is not the CLI. On Downloads, link the CLI card directly to the CLI repo rather than only to the GitHub org.
- Fill GitHub About description, website, and topics: `ai-agent`, `coding-agent`, `cli`, `terminal`, `llm`, `mcp`, `developer-tools`.

### P0 - Prod dependency audit has high-severity findings

Evidence from `npm audit --omit=dev --json`:

- `undici` via `@earendil-works/pi-ai`
- `protobufjs` via `@google/genai` through `@earendil-works/pi-ai`
- `ws` via `ink`, `openai`, `@google/genai`, and `@mistralai/mistralai`
- `brace-expansion` via `glob` -> `minimatch`

Impact: install still works, but launch reviewers and security-conscious users will notice. Some issues are transitive network-client/parser packages, which matter for a CLI that handles credentials and remote APIs.

Suggested fix: bump upstream deps where possible, or use npm `overrides` after compatibility testing. Keep `npm audit --omit=dev` as a pre-launch gate or explicitly document accepted residual risk.

### P1 - Invalid API key error is raw provider JSON

Fresh BYOK flow was pleasant until a fake key was used. The app accepted it, entered the TUI, and then a first prompt produced:

```text
ERROR 401
{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"..."}
```

Impact: this is accurate but not helpful. First-time users need a recovery path at the moment of failure.

Suggested fix: catch provider auth failures and render a friendly message:

```text
That API key was rejected by Anthropic.
Run `codebase auth login`, `codebase auth <new-key>`, or `/model` to switch providers.
```

If practical, validate key shape before saving and optionally perform a cheap auth check before entering the TUI.

Partially fixed in this branch: the non-interactive `codebase auth <token>` path now rejects provider-looking keys such as `sk-ant-...` and points users to the first-run BYOK wizard or `*_API_KEY` env vars. Runtime provider errors should still be friendlier in the TUI.

### P1 - Headless runs could report false success

Evidence before fix:

- Bad saved manual token: `codebase run --output json "say only hi"` returned `ok: true`, `exitCode: 0`, `finalText: ""`, while the final assistant message contained `stopReason: "error"` and `errorMessage: "401 \"invalid_token\""`.
- Authenticated write task without `--auto-approve`: text mode printed `[write_file…]`, created no file, and exited `0`; JSON mode exited `0` with no JSON envelope.

Fixed in this branch:

- Assistant `stopReason: "error"` / `errorMessage` now turns into `ok: false`, non-zero exit, and a structured error.
- Headless runs that cannot answer tool approvals now return `code: "approval_required"` and exit `2`.

### P1 - Project listing flooded the terminal for active accounts

Evidence before fix:

- `codebase project list` on this account returned 83 projects, mostly storage-only and untitled, and printed the full list.

Fixed in this branch:

- Default output is bounded to 25 entries.
- `--limit N` and `--all` are supported.
- Indexed/titled projects sort before raw storage-only entries.

Remaining follow-up: consider grouping/paging storage-only projects separately if active accounts still feel noisy.

### P1 - Proxy usage/cost metadata is zero

Evidence:

- Authenticated `codebase run --auto-approve --output json "Reply with exactly READY"` returned the correct `finalText`, but `usage.input`, `usage.output`, `totalTokens`, and cost were all `0`.
- Re-tested with authenticated `codebase auto --output json "Reply with exactly READY..."` and a tiny app-build prompt. Both successful JSON envelopes still reported all usage/cost fields as `0`.

Impact: `/cost`, JSON automation, and user trust around credits/accounting are weaker if the CLI cannot show real usage for Codebase-proxied calls.

Suggested fix: have the inference proxy return provider usage in the response shape pi-ai reads, or translate backend accounting into the CLI envelope.

### P1 - Default model naming differs by surface

Evidence:

- CLI OAuth/proxy default now resolves to `codebase/d4f` named `Codebase Auto`.
- Web settings UI defaults to `d4f` / `Codebase Auto`.
- Web backend registry fallback `DEFAULT_MODEL` is `process.env.DEFAULT_MODEL || process.env.OPENAI_MODEL || "deepseek-v4-flash"`, so API/build paths that omit a model can default to the official DeepSeek route rather than the in-house Codebase Auto route.

Impact: when users ask "what model did my build use?", the honest answer can vary by surface and by whether a model was explicitly carried through the request. That is fine if intentional, but it should be named deliberately in docs/API responses.

Suggested fix: pick the launch default contract. If "Codebase Auto" is the product default, make omitted-model API/build paths resolve to `d4f` or return an explicit `resolvedModel` field in build/session responses so the UI and CLI can show exactly what ran.

### P2 - Project pull works; unzip hint is now destination-aware

Evidence before fix:

- `codebase project pull hello-166dcae6 /tmp/.../hello.zip` downloaded a valid 12 MB zip.
- The follow-up hint printed `unzip -d ./hello-166dcae6 /tmp/.../hello.zip`, which extracts relative to the current shell directory, not next to the zip destination.

Fixed in this branch: the hint now quotes paths and extracts beside the downloaded zip. Live smoke with a destination containing spaces printed:

```sh
unzip -d '/tmp/codebase pull smoke.XXXXXX/hello-166dcae6' '/tmp/codebase pull smoke.XXXXXX/hello.zip'
```

### P2 - Interactive help is complete but dense

Evidence:

- Interactive `/help` lists the right commands and shortcuts, including `/diff` and `/doctor`.
- On an 80-column terminal it is a long wall of text with wrapped descriptions.

Suggested fix: group commands by workflow (setup, model, files/diff, session, advanced) or add paged help/search. `/diff` itself looked good: it showed shortstat and the exact hunk for the temp repo change.

### P1 - Domain naming is inconsistent

Examples:

- README and install URLs use `codebase.design`.
- Fixed in this branch: CLI top-level help now says `codebase.design browser OAuth`.
- Fixed in this branch and companion web install scripts: install success copy now says "free Codebase credits."
- Older docs still discuss `codebase.foundation` as the web/OAuth surface.

Impact: this makes the product feel less unified during the exact moment when users are deciding whether to trust auth and credentials.

Suggested fix: choose user-facing wording and make it consistent:

- User-facing brand/auth: `codebase.design`
- Implementation/backward-compatible API host: only mention in developer docs when necessary.
- Continue pruning old `codebase.foundation` docs when those docs are refreshed.

### P1 - Top-level CLI now exposes diagnostics/configuration

Evidence before fix: `codebase --help` did not mention `doctor`, even though `/doctor` exists and is exactly what a stuck installer/configurer needs.

Fixed in this branch:

- Added `codebase doctor`.
- Added `codebase doctor --help`.
- Added `codebase doctor` to top-level help.

Fresh temp `HOME` smoke output included Node version, signed-out state, setup hint, model-resolution note, web-search config status, and writable data-root status.

### P1 - First-run wizard is good, but configuration should be easier to revisit

Good:

- Clean HOME opens provider chooser immediately.
- BYOK provider list is broad.
- Key prompt explains `~/.codebase/credentials.json` and mode `0600`.
- Fake BYOK entry gets into the app quickly.

Improve:

- After saving a BYOK key, show a one-line "Saved Anthropic key. Switch later with `/model` or `codebase auth login`."
- On no-provider headless failure, include a shorter human line before JSON when stdout is a terminal; keep pure JSON for automation.
- Consider a `codebase config` or `codebase auth setup` command that reopens the first-run wizard.

### P2 - Release channel semantics need a deliberate decision

Registry state:

- `latest`: `2.0.0-pre.73`
- `pre`: `2.0.0-pre.73`

The release workflow is designed so prereleases publish under `pre`, not `latest`, but `latest` has been promoted to a prerelease.

Impact: this may be intentional for launch, but it means the README's `npm i -g codebase-cli` gives everyone the prerelease. That is fine only if `2.0.0-pre.73` is the intended public default.

Suggested fix: either cut `2.0.0` and make that `latest`, or be explicit in README/install copy that the CLI is currently a public beta.

### P2 - Public README is strong, but a five-minute path would help

The README sells advanced features well. For brand-new users, add a very small "First useful task" section after install:

```sh
cd your-project
codebase
```

Then prompt examples:

```text
summarize this repo and suggest the safest first issue
run the tests and fix the first failing one
add a small feature, then show me the diff before committing
```

This helps users move from "agent installed" to "agent did something useful" without needing to understand tournaments, MCP, memories, hooks, or subagents first.

## Overall Call

CLI core: promising, and after the fixes in this branch the local gate is green.

Launch funnel: not ready to call "amazing" until the npm README, web CLI discoverability, raw auth error, and prod audit story are handled or consciously accepted.
