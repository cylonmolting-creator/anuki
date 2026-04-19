#!/usr/bin/env bash
# Rule 021 audit at Stop: diff current state vs baseline; if any artifact
# created this session is still present (file/dir/proc), block the response
# with the exact cleanup commands per item.
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "default"')
violations=$("$BASEDIR/scripts/cleanup-tracker.sh" audit "$sid" 2>/dev/null || true)
[ -z "$violations" ] && exit 0
detail=$(echo "$violations" | awk -F'|' '{
  if ($1=="FILE") printf "  unlink %s\n", $2;
  else if ($1=="DIR") printf "  node -e \"fs.rmSync('"'"'%s'"'"',{recursive:true,force:true})\"\n", $2;
  else if ($1=="PROC") printf "  kill %s    # %s\n", $2, $3;
}')
msg="RULE 021 CLEANUP BLOCK — session artifacts not cleaned up:

$detail"
jq -nc --arg msg "$msg" '{hookSpecificOutput:{hookEventName:"Stop",permissionDecision:"deny",permissionDecisionReason:$msg},decision:"block",reason:$msg}'
exit 1
