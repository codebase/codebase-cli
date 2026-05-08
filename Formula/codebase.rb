# Homebrew formula for codebase-cli.
#
# This file is the source of truth — the actual tap repo at
# github.com/codebase-foundation/homebrew-codebase syncs this file on
# every release. See docs/DISTRIBUTION.md (section 4) for tap setup.
#
# Bumping for a new release:
#   1. Update `url` to the new npm tarball.
#   2. Update `sha256` (run: `curl -sL <url> | shasum -a 256`).
#   3. Update `version` if it doesn't match the URL automatically.
#   4. Copy the file into github.com/codebase-foundation/homebrew-codebase/Formula/codebase.rb.
#   5. Commit + push that tap repo.
#
# After v2.0.0 GA, the bump can be automated via a release workflow
# that opens a PR against the tap (see Phase 12.5).
class Codebase < Formula
  desc "AI coding agent in your terminal — TypeScript, multi-provider, OAuth-aware"
  homepage "https://codebase.foundation"
  # Replace VERSION_PLACEHOLDER with the published version on each bump.
  url "https://registry.npmjs.org/@codebase-foundation/cli/-/cli-VERSION_PLACEHOLDER.tgz"
  sha256 "SHA256_PLACEHOLDER"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "codebase",
                 shell_output("#{bin}/codebase --version")
  end
end
