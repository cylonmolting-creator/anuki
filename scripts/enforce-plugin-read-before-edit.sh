#!/usr/bin/env bash
# Rule 020: PreToolUse Edit|Write must have a prior Read of the target file
# in this session's tracker (/tmp/anuki-read-files-<sid>).
set -u
input=$(cat)
fp=$(echo "$input" | jq -r '.tool_input.file_path // empty')
sid=$(echo "$input" | jq -r '.session_id // "default"')
sf="/tmp/anuki-read-files-$sid"
[ -z "$fp" ] && exit 0
# Don't block files that don't exist on disk (new file creation is fine)
[ ! -f "$fp" ] && exit 0
if [ ! -f "$sf" ] || ! grep -qxF "$fp" "$sf" 2>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"RULE 020 BLOCK: Bu dosyayı henüz Read/Grep ile okumadın. Varsayım yasağı — önce oku, sonra düzenle."}}'
  exit 1
fi
exit 0
