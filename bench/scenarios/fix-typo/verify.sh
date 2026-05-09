#!/bin/sh
# fix-typo verify: greeting must say "hello world", typo must be gone.
set -e

if [ ! -f "src/index.ts" ]; then
	echo "FAIL: src/index.ts is missing — agent shouldn't have deleted it" >&2
	exit 1
fi

if grep -q "helo world" src/index.ts; then
	echo "FAIL: typo 'helo world' still present" >&2
	exit 2
fi

if ! grep -q "hello world" src/index.ts; then
	echo "FAIL: 'hello world' not present after edit" >&2
	exit 3
fi

# Sanity: the function is still exported (agent didn't break the API).
if ! grep -qE "^export function greet" src/index.ts; then
	echo "FAIL: export function greet(...) signature is gone" >&2
	exit 4
fi

echo "ok"
