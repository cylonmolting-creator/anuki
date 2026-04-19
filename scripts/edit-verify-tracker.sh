#!/bin/bash
# Edit verification tracker (Rule 012)
#
# Invoked from PostToolUse Edit|Write: checks that the new_string is
# actually on disk after the tool ran. If mismatch/missing, appends an
# entry to the session-scoped failure tracker. The Stop hook reads this
# tracker and blocks the response until every entry is either cleared
# (via re-verify) or explicitly explained.
#
# Why a tracker: PostToolUse cannot deny the tool (it already ran), only
# flag via additionalContext. A Stop-hook gate forces the agent to
# acknowledge and fix before the response leaves.
#
# Usage:
#   PostToolUse invokes:  cat | edit-verify-tracker.sh record <session_id>
#   Stop invokes:         edit-verify-tracker.sh audit <session_id>
#   Re-verify clears:     edit-verify-tracker.sh clear <session_id>

set -u
CMD="${1:-}"
SID="${2:-default}"
TRACKER="/tmp/anuki-edit-failures-${SID}"

case "$CMD" in
  record)
    input=$(cat)
    fp=$(echo "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)
    ns=$(echo "$input" | jq -r '.tool_input.new_string // empty' 2>/dev/null)
    if [ -z "$fp" ] || [ -z "$ns" ]; then exit 0; fi
    if [ ! -f "$fp" ]; then
      echo "MISSING_FILE|$fp|file does not exist on disk after Edit/Write" >> "$TRACKER"
      jq -nc --arg f "$fp" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("CRITICAL: File not on disk - " + $f + ". Edit did not apply. Stop will block until verified.")}}'
      exit 0
    fi
    # Sample the first non-trivial line of new_string (first 40 alnum chars)
    sample=$(echo "$ns" | head -5 | tr -d '\n' | sed 's/[^a-zA-Z0-9_ ]//g' | head -c 40)
    if [ -z "$sample" ]; then exit 0; fi
    if ! grep -qF "$sample" "$fp" 2>/dev/null; then
      echo "MISMATCH|$fp|expected: ${sample}" >> "$TRACKER"
      jq -nc --arg f "$fp" --arg s "$sample" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("CRITICAL: Edit did NOT apply to " + $f + " - expected text not found: " + $s + ". Re-read the file, diagnose the mismatch (TextEdit open? sandbox-sync? permissions?), re-apply, then run edit-verify-tracker.sh clear to unblock.")}}'
    fi
    ;;

  audit)
    if [ ! -s "$TRACKER" ]; then exit 0; fi
    count=$(wc -l < "$TRACKER" | tr -d ' ')
    detail=$(cat "$TRACKER" | awk -F'|' '{printf "  - %s: %s (%s)\n", $1, $2, $3}')
    echo "RULE 012 BLOCK: $count edit verification failure(s) unresolved this session."
    echo ""
    echo "$detail"
    echo ""
    echo "Fix each by: Read the file, verify/re-apply the edit, then run:"
    echo "  scripts/edit-verify-tracker.sh clear $SID"
    exit 1
    ;;

  clear)
    if [ -f "$TRACKER" ]; then unlink "$TRACKER"; fi
    echo "cleared"
    ;;

  *)
    echo "usage: $0 {record|audit|clear} <session_id>" >&2
    exit 2
    ;;
esac
