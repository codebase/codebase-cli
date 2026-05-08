#!/bin/sh
# Copy install.sh and install.ps1 into the web app's public/ directory
# so codebase.design/install.sh and /install.ps1 serve the latest
# versions. Run after editing either installer in this repo.
#
# Default target: ../web/public (this monorepo's layout).
# Override:       WEB_PUBLIC_DIR=/path/to/web/public ./scripts/sync-install-scripts.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${WEB_PUBLIC_DIR:-${REPO_ROOT}/../web/public}"

if [ ! -d "$TARGET" ]; then
	printf "✗ target dir does not exist: %s\n" "$TARGET" >&2
	printf "   set WEB_PUBLIC_DIR=/your/path/to/web/public and re-run.\n" >&2
	exit 1
fi

# Resolve the absolute target path so messages don't include `..` segments.
TARGET="$(cd "$TARGET" && pwd)"

for f in install.sh install.ps1; do
	src="${REPO_ROOT}/${f}"
	dst="${TARGET}/${f}"
	if [ ! -f "$src" ]; then
		printf "✗ source missing: %s\n" "$src" >&2
		exit 1
	fi
	if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
		printf "  unchanged: %s\n" "$dst"
		continue
	fi
	cp "$src" "$dst"
	# Preserve executable bit only on install.sh.
	if [ "$f" = "install.sh" ]; then
		chmod +x "$dst"
	fi
	printf "✓ updated:  %s\n" "$dst"
done

printf "\nDone. Commit the updated files in the web repo and redeploy.\n"
