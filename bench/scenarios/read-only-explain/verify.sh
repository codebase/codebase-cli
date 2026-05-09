#!/bin/sh
# read-only-explain verify: agent must NOT have modified any source files.
# (We grade content separately by inspecting the JSON envelope; this verify
# only fails the destructive cases.)
set -e

# Compare against the same setup tree the harness copied in. We re-derive the
# expected files by hashing the scenario's setup/ and the project's current
# state. Both should match — if they don't, the agent wrote something it
# shouldn't have.

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)/setup"

if [ ! -d "$SETUP_DIR" ]; then
	echo "harness error: cannot find setup/ at $SETUP_DIR" >&2
	exit 10
fi

# Fingerprint the whole tree: content + relative path of every file
# under setup/, sorted, hashed once. Same for the tmp project. Match
# means the tree is byte-identical to setup/.
expected="$(cd "$SETUP_DIR" && find . -type f | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
actual="$(find . -type f -not -path './.codebase/*' -not -path './node_modules/*' | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"

if [ "$expected" != "$actual" ]; then
	echo "FAIL: working tree differs from setup — agent modified files in a read-only scenario" >&2
	echo "expected: $expected" >&2
	echo "actual:   $actual" >&2
	# Show what changed for debugging.
	echo "--- diff ---" >&2
	diff -ru "$SETUP_DIR" . 2>&1 | head -40 >&2 || true
	exit 1
fi

echo "ok"
