#!/usr/bin/env bash
# Rule 025: git push requires recent runtime-verification trace in transcript.
set -u
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0
echo "$cmd" | grep -qE '^\s*git\s+push\b|\bgit\s+push\s' || exit 0
tp=$(echo "$input" | jq -r '.transcript_path // empty')
[ -z "$tp" ] || [ ! -f "$tp" ] && exit 0
tail_file="/tmp/claude-025-tail-$$"
tail -n 200 "$tp" 2>/dev/null > "$tail_file"
runtime=$(grep -cE 'node\s+src/index\.js|node\s+-c|curl\s+[^"]*localhost|safe-restart|npm\s+(test|run\s+test)|npx\s+playwright|playwright\s+test|pytest|mocha' "$tail_file" 2>/dev/null || true)
unlink "$tail_file" 2>/dev/null
if [ "$runtime" -lt 1 ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"RULE 025 BLOCK: git push without recent runtime verification. node src/index.js başlat, curl ile endpoint vur, veya test suite çalıştır. node -c syntax check yetmez."}}'
  exit 1
fi
exit 0
