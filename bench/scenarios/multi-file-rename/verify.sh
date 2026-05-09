#!/bin/sh
# multi-file-rename verify: parseDate must be GONE everywhere, parseTimestamp
# must be defined once and called from at least 2 callers. The 3 source files
# must still exist.
set -e

for f in src/parse.ts src/main.ts src/util.ts; do
	if [ ! -f "$f" ]; then
		echo "FAIL: $f is missing — agent shouldn't have deleted it" >&2
		exit 1
	fi
done

# No residual parseDate identifier anywhere. Use \b to avoid matching
# subwords like `parseDateString`.
if grep -REn '\bparseDate\b' src/ ; then
	echo "FAIL: residual references to parseDate above — rename incomplete" >&2
	exit 2
fi

# Definition: src/parse.ts must export parseTimestamp.
if ! grep -qE '^export function parseTimestamp\b' src/parse.ts; then
	echo "FAIL: src/parse.ts must export parseTimestamp" >&2
	exit 3
fi

# Callers: at least 2 files that aren't src/parse.ts must import or call
# parseTimestamp.
caller_files="$(grep -lE '\bparseTimestamp\b' src/main.ts src/util.ts 2>/dev/null | wc -l | tr -d ' ')"
if [ "$caller_files" -lt 2 ]; then
	echo "FAIL: only $caller_files of 2 caller files reference parseTimestamp" >&2
	exit 4
fi

echo "ok"
