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

## 1. Reserve the npm scope

**Owner:** anyone with an npmjs.com account. Free.

1. Sign in at <https://www.npmjs.com/>.
2. Create an organization named `codebase-foundation`. Pick the **Free
   (Public Packages)** plan.
3. Generate an automation token:
   - Profile → Access Tokens → Generate New Token
   - Type: **Granular Access Token** (preferred) or **Automation**
   - Packages and scopes: full read+write on `@codebase-foundation/*`
   - Expiration: 1 year is fine; calendar a refresh.
4. Add the token to GitHub as a repo secret:
   - `gh secret set NPM_TOKEN --body "<paste token>"`
   - Or via the web UI: Settings → Secrets and variables → Actions →
     New repository secret → `NPM_TOKEN`.
5. Verify locally (optional):
   ```sh
   npm whoami --registry https://registry.npmjs.org/
   npm access list packages @codebase-foundation
   ```

After this, the `release.yml` workflow can publish.

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
npm publish --access public
```

`prepublishOnly` re-runs `clean → check → build` before publish, so
the tarball is always built from a passing checkout.

After it succeeds, smoke-test the install path on a fresh box:

```sh
npm install -g @codebase-foundation/cli
codebase --version
codebase auth status
```

If anything's broken, `npm unpublish @codebase-foundation/cli@<version>`
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
   curl -sL https://registry.npmjs.org/@codebase-foundation/cli/-/cli-2.0.0-rc.1.tgz \
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

## 5. Wire up codebase.foundation/install.sh

**Owner:** whoever owns the codebase.foundation web app.

The install command in the README is:

```sh
curl -fsSL https://codebase.foundation/install.sh | sh
```

Two ways to serve `install.sh`:

- **Static file** mounted at `/install.sh` from the web app's public
  dir. Source of truth: this repo's `install.sh`. Mirror it on every
  release (a small CI step, e.g. a webhook that pulls the file from
  `main` to the web app's bucket).
- **Redirect** to
  `https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.sh`.
  Quickest to set up; loses caching but is one fewer source of drift.

Either way, also make `https://codebase.foundation/install.ps1`
resolve to the PowerShell installer in this repo.

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
