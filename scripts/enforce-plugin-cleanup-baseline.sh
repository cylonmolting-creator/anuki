#!/usr/bin/env bash
# Rule 021 baseline: snapshot /tmp, ~/Desktop, ~/Downloads + long-lived procs
# on first UserPromptSubmit. Delegates to cleanup-tracker.sh baseline.
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "default"')
"$BASEDIR/scripts/cleanup-tracker.sh" baseline "$sid" 2>/dev/null || true
exit 0
