#!/usr/bin/env bash
# Rule 013: block when the same file has been edited 5+ times across ALL sessions.
# Global tracker: /tmp/anuki-edit-counts-global (persists across sessions).
# Reset manually: > /tmp/anuki-edit-counts-global
set -u
input=$(cat)
fp=$(echo "$input" | jq -r '.tool_input.file_path // empty')
ef="/tmp/anuki-edit-counts-global"
[ -z "$fp" ] && exit 0
echo "$fp" >> "$ef"
count=$(grep -cxF "$fp" "$ef" 2>/dev/null || true)
if [ "$count" -ge 5 ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"RULE 013 BLOCK: 5+ edits to same file (cross-session). Find root cause, check diff, revert if needed. Reset: > /tmp/anuki-edit-counts-global"}}'
  exit 1
fi
exit 0
