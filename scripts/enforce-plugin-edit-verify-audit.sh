#!/usr/bin/env bash
# Rule 012 audit at Stop: read tracker, emit Stop block if non-empty.
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "default"')
out=$("$BASEDIR/scripts/edit-verify-tracker.sh" audit "$sid" 2>/dev/null)
ec=$?
if [ "$ec" -eq 1 ] && [ -n "$out" ]; then
  # Stop hook deny payload format
  jq -nc --arg msg "$out" '{hookSpecificOutput:{hookEventName:"Stop",permissionDecision:"deny",permissionDecisionReason:$msg},decision:"block",reason:$msg}'
  exit 1
fi
exit 0
