#!/usr/bin/env bash
# SessionStart: rebuild the rule catalogue index from rules/*.md (existing
# build-rules.js script — preserved as a silent side-effect).
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
node "$BASEDIR/scripts/build-rules.js" --quiet 2>/dev/null || true
exit 0
