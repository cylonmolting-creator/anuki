#!/usr/bin/env bash
# Rule 013: block when the same file has been edited 5+ times in this session.
# Tracker file: /tmp/anuki-edit-counts-<session_id>. Append file_path on each
# invocation; count exact-line occurrences; block at threshold.
set -u
input=$(cat)
fp=$(echo "$input" | jq -r '.tool_input.file_path // empty')
sid=$(echo "$input" | jq -r '.session_id // "default"')
ef="/tmp/anuki-edit-counts-$sid"
[ -z "$fp" ] && exit 0
echo "$fp" >> "$ef"
count=$(grep -cxF "$fp" "$ef" 2>/dev/null || true)
if [ "$count" -ge 5 ]; then
  jq -nc --arg sid "$sid" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:("RULE 013 BLOCK: 5+ edits to same file. Root cause bul, diff kontrol, gerekirse revert. Reset: > /tmp/anuki-edit-counts-"+$sid)}}'
  exit 1
fi
exit 0
