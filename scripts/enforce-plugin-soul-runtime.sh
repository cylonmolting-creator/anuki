#!/usr/bin/env bash
# Rule 011: WARN when editing a soul file while recent transcript shows
# runtime error signatures (soul is a prompt, bugs live in src/).
set -u
input=$(cat)
fp=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$fp" ] && exit 0
echo "$fp" | grep -qE 'workspace/[^/]+/soul/[^/]+\.md$' || exit 0
tp=$(echo "$input" | jq -r '.transcript_path // empty')
[ -z "$tp" ] || [ ! -f "$tp" ] && exit 0
err_hits=$(tail -n 100 "$tp" 2>/dev/null | grep -ciE 'TypeError|ReferenceError|stack trace|executor\.js:[0-9]+|\bcrash\b|uncaughtException|EADDRINUSE|ENOENT' || true)
if [ "$err_hits" -ge 2 ]; then
  jq -nc --arg f "$fp" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("RULE 011 NOTE: Editing soul file " + $f + " while recent transcript shows runtime error signatures. Soul = PROMPT, not runtime code. Crash fix'"'"'i src/'"'"'de yapılır. Confirm bu prompt-level bir değişiklik, band-aid değil.")}}'
fi
exit 0
