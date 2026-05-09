#!/bin/sh
# add-test verify: src/math.test.ts must exist with at least 2 tests
# referencing both `add` and `multiply`, using vitest's describe/it/expect.
set -e

TARGET="src/math.test.ts"

if [ ! -f "$TARGET" ]; then
	echo "FAIL: $TARGET was not created" >&2
	exit 1
fi

if [ ! -f "src/math.ts" ]; then
	echo "FAIL: src/math.ts is missing — agent shouldn't have deleted it" >&2
	exit 2
fi

# Must import from vitest (the prompt says so explicitly).
if ! grep -qE "from ['\"]vitest['\"]" "$TARGET"; then
	echo "FAIL: $TARGET must import from 'vitest'" >&2
	exit 3
fi

# Must reference both functions under test.
if ! grep -q "\\badd\\b" "$TARGET" || ! grep -q "\\bmultiply\\b" "$TARGET"; then
	echo "FAIL: $TARGET must test both add and multiply" >&2
	exit 4
fi

# Must contain at least two test cases (it/test calls).
test_calls="$(grep -cE "^\\s*(it|test)\\s*\\(" "$TARGET" || true)"
if [ "$test_calls" -lt 2 ]; then
	echo "FAIL: $TARGET has $test_calls test calls (need ≥2)" >&2
	exit 5
fi

# Must contain at least two expect calls (a test that doesn't assert is dead).
expect_calls="$(grep -cE "expect\\s*\\(" "$TARGET" || true)"
if [ "$expect_calls" -lt 2 ]; then
	echo "FAIL: $TARGET has $expect_calls expect() calls (need ≥2)" >&2
	exit 6
fi

echo "ok ($test_calls tests, $expect_calls expects)"
