# Distribution Operator Checklist

Phase 12 ships codebase-cli v2 to npm, Homebrew, and the curl|sh
installer at codebase.foundation. Everything in `package.json`,
`install.sh`, the migration doc, the release workflow, and the
Homebrew formula skeleton is committed to this repo. The steps below
are the **manual / external** work that only an operator with the
right credentials can do.

Run them in order. Each step is independent enough that you can pause
between them.

---

## 1. Claim the npm name

**Owner:** anyone with an npmjs.com account. Free.

The package is published as the **unscoped** name `codebase-cli` —
no org or scope to create. The name was confirmed available on
2026-05-08; the first `npm publish` claims it.

1. Sign in at <https://www.npmjs.com/> (or `npm adduser` from the
   shell).
2. Generate an automation token for CI:
   - Profile → Access Tokens → Generate New Token
   - Type: **Granular Access Token** (preferred) or **Automation**
   - Packages and scopes: full read+write on `codebase-cli`
   - Expiration: 1 year is fine; calendar a refresh.
3. Add the token to GitHub as a repo secret:
   - `gh secret set NPM_TOKEN --body "<paste token>"`
   - Or via the web UI: Settings → Secrets and variables → Actions →
     New repository secret → `NPM_TOKEN`.
4. Verify locally (optional):
   ```sh
   npm whoami --registry https://registry.npmjs.org/
   ```

After the first publish, the package belongs to the publishing
account; subsequent publishes from CI use the `NPM_TOKEN`.

---

## 2. First publish (manual smoke test)

**Owner:** anyone with `NPM_TOKEN`. Run from a clean checkout of the
default branch.

```sh
# 1. Make sure the working tree is clean and tests pass
npm ci
npm run check
npm run build

# 2. Inspect the tarball that would ship
npm pack --dry-run

# 3. Publish (NOTE: this is irreversible — version + tag are locked in
#    on npm forever)
npm publish
```

`prepublishOnly` re-runs `clean → check → build` before publish, so
the tarball is always built from a passing checkout.

After it succeeds, smoke-test the install path on a fresh box:

```sh
npm install -g codebase-cli
codebase --version
codebase auth status
```

If anything's broken, `npm unpublish codebase-cli@<version>`
within 72 hours of publish.

---

## 3. Tag v1 on the Go branch

**Owner:** repo maintainer. Run on `anthropic-support` (the last v1
branch).

```sh
git checkout anthropic-support
git tag v1.0.0 -m "Last Go release before v2 rewrite"
git push origin v1.0.0
```

This locks the v1 install URL referenced in `MIGRATION_v1_to_v2.md`'s
rollback section. Afterward, set `v2` as the GitHub default branch:

```sh
gh repo edit --default-branch v2
```

---

## 4. Set up the Homebrew tap

**Owner:** repo maintainer. Requires a second GitHub repo.

Homebrew taps are GitHub repos named `homebrew-<tap>`. For the install
URL `brew install codebase-foundation/codebase/codebase` to work, you
need:

```
github.com/codebase-foundation/homebrew-codebase
└── Formula/
    └── codebase.rb
```

Steps:

1. Create the repo:
   ```sh
   gh repo create codebase-foundation/homebrew-codebase --public \
     --description "Homebrew tap for codebase-cli" --clone
   ```
2. Copy the formula from this repo:
   ```sh
   mkdir -p homebrew-codebase/Formula
   cp /path/to/codebase-cli/Formula/codebase.rb \
     homebrew-codebase/Formula/codebase.rb
   ```
3. After your first npm publish, get the tarball SHA256:
   ```sh
   curl -sL https://registry.npmjs.org/codebase-cli/-/cli-2.0.0-rc.1.tgz \
     | shasum -a 256
   ```
4. Edit `Formula/codebase.rb` to set the right `url` and `sha256` (the
   committed file has placeholders).
5. Push:
   ```sh
   cd homebrew-codebase
   git add Formula/codebase.rb
   git commit -m "codebase 2.0.0-rc.1"
   git push
   ```
6. Verify locally:
   ```sh
   brew tap codebase-foundation/codebase
   brew install codebase
   codebase --version
   ```

For every subsequent release, bump `url`, `sha256`, and `version` in
`codebase.rb`. (Phase 12.5: a release-please-style action that opens a
PR against the tap on every npm publish.)

---

## 5. Keep the install scripts on codebase.design fresh

**Owner:** whoever owns the codebase.design / codebase.foundation web
app. The two domains both point at the Next.js app under
`polyvibe-poc/web/`; the canonical user-facing install URL is
`codebase.design/install.sh` (and `/install.ps1`).

The install commands in the README are:

```sh
curl -fsSL https://codebase.design/install.sh | sh
irm  https://codebase.design/install.ps1 | iex
```

These resolve to static files under `polyvibe-poc/web/public/`:

```
polyvibe-poc/web/public/install.sh   ← served at codebase.design/install.sh
polyvibe-poc/web/public/install.ps1  ← served at codebase.design/install.ps1
```

`codebase-cli/install.sh` and `codebase-cli/install.ps1` are the
**source of truth** — they live next to the CLI so they're versioned
and tested with it. The copies under `web/public/` need to be synced
on every CLI release. Run from inside `codebase-cli/`:

```sh
./scripts/sync-install-scripts.sh
```

That copies both files into `../web/public/` and reports the diff. The
sibling-path assumption (`../web/`) matches this monorepo layout; if
the repos are checked out elsewhere, set `WEB_PUBLIC_DIR` first:

```sh
WEB_PUBLIC_DIR=/path/to/web/public ./scripts/sync-install-scripts.sh
```

Then commit the updated files in the `polyvibe-poc` repo and redeploy
the web app. Until that's deployed, the new installer is live only on
disk; users hitting `codebase.design/install.sh` get whatever was
deployed last.

> ⚠️ **Next.js rebuild required for new files.** In production mode
> (`next start`), Next.js bakes the `public/` file list at `next build`
> time — adding a new file (e.g. an installer that didn't exist
> before) returns 404 until the next build. Editing an *existing*
> file's contents serves immediately without rebuild. So the first
> time you add `install.sh` / `install.ps1`, run:
>
> ```sh
> cd /path/to/polyvibe-poc/web
> npm run build
> pm2 reload codebase-frontend     # graceful restart on PM2
> ```
>
> Subsequent edits to those files are picked up without a rebuild.

(If you'd rather avoid the manual sync, two safe alternatives are: a
prebuild step in `web/package.json` that runs the sync script, or a
302 redirect from `/install.sh` to
`https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.sh` —
quickest, but loses caching and the GitHub repo must be public.)

---

## 6. Future: Bun single-binary distribution

Not required for v2.0.0. When demand arrives:

1. Add `bun build --compile --target=bun-<platform>` matrix to
   `release.yml`.
2. Upload the resulting binaries to GitHub Releases as
   `codebase-<version>-<platform>-<arch>(.exe)?`.
3. Update `install.sh` to detect platform, fetch the binary, and skip
   the npm path entirely. The binary path is preferable for users
   without Node — it's how Bun, Deno, and fzf distribute.

The npm and Homebrew paths stay first-class either way. The binary is
just a faster on-ramp for new users.

---

## Release cadence (suggested)

| Version | What | Channel |
|---|---|---|
| 2.0.0-pre.0 | Internal smoke; not advertised | npm `pre` tag |
| 2.0.0-rc.1 | Public beta, advertised in release notes | npm `next` tag, brew formula |
| 2.0.0 | GA. Default `latest` tag flips. | npm `latest`, brew formula, hero install in README |
| 2.0.x | Patch releases | npm `latest`, brew bumps via PR |
| 2.1.0 | Next minor (boot animation? Bun binary?) | new release notes |

The npm `dist-tag` is the canary — bump `latest` only when you're
confident a fresh install actually works on Linux + macOS + Windows.
