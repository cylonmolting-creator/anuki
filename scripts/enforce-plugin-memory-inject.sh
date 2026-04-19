#!/usr/bin/env bash
# SessionStart: inject workspace MEMORY.md contents into context.
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
MEMDIR="$BASEDIR/workspace"
content=''
for agent_dir in "$MEMDIR"/*/; do
  mem="${agent_dir}MEMORY.md"
  [ -f "$mem" ] && content="$content--- $(basename "$agent_dir") ---
$(cat "$mem")
"
done
[ -z "$content" ] && exit 0
printf '%s' "$content" | jq -Rsc '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}'
exit 0
