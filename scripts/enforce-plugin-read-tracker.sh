#!/usr/bin/env bash
# Append every Read/Grep target to the session's read-tracker so Rule 020
# (read-before-edit) can verify a prior read.
set -u
input=$(cat)
fp=$(echo "$input" | jq -r '.tool_input.file_path // empty')
sid=$(echo "$input" | jq -r '.session_id // "default"')
[ -z "$fp" ] && exit 0
sf="/tmp/anuki-read-files-$sid"
# de-dupe: append only if not already present
if [ ! -f "$sf" ] || ! grep -qxF "$fp" "$sf" 2>/dev/null; then
  echo "$fp" >> "$sf"
fi
exit 0
