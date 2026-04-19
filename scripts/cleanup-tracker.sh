#!/bin/bash
# DYNAMIC ARTIFACT TRACKER — session-scoped garbage detector
#
# Not pattern-based. Takes a baseline snapshot of /tmp, ~/Desktop, ~/Downloads
# and background processes at session start, then on every Stop compares against
# baseline. Anything the session created and didn't clean up → violation.
#
# Usage:
#   cleanup-tracker.sh baseline <session_id>      → take baseline (idempotent)
#   cleanup-tracker.sh audit    <session_id>      → compare & print violations
#                                                   (exit 1 if any, 0 if clean)
#
# Whitelist: things that are allowed to persist (OS-internal, user-owned
# long-lived state, the baseline files themselves).
#
# Output format (audit, when violations exist):
#   one violation per line, each line is: "<type>|<path-or-pid>|<detail>"
# Types: FILE, DIR, PROC

set -u

CMD="${1:-}"
SID="${2:-default}"
BASELINE_DIR="/tmp"
BASELINE_FILE="$BASELINE_DIR/claude-baseline-${SID}.txt"

# Whitelist patterns (grep -E). Items matching these are NEVER reported.
# Keep this list tight — we want false negatives to be rare.
WHITELIST='^(/tmp/\.s\.PGSQL|/tmp/\.com\.apple|/tmp/claude-baseline-|/tmp/claude-|/tmp/profanity2-sandbox-|/tmp/profanity-cl-backup-|/tmp/vh\.pid|/tmp/cylon-edit-counts-|/tmp/cylon-read-files-|/tmp/anuki-edit-counts-|/tmp/anuki-read-files-|.*\.DS_Store$|/tmp/powerlog)'

snapshot_files() {
  # List files/dirs at top level of /tmp, ~/Desktop, ~/Downloads
  # -maxdepth 1 so we don't recurse into huge dirs
  {
    find -L /tmp -maxdepth 1 -mindepth 1 2>/dev/null
    find -L "$HOME/Desktop" -maxdepth 1 -mindepth 1 2>/dev/null
    find -L "$HOME/Downloads" -maxdepth 1 -mindepth 1 2>/dev/null
  } | sort -u
}

snapshot_procs() {
  # Long-lived processes we care about: node, python, ruby
  # (claude CLI excluded — it's the agent runtime, not an orphan)
  # Format: PID|ETIME|CWD|CMD
  # Match only processes whose binary basename is node/python/ruby.
  # Using awk to match the first whitespace-separated token of the command
  # avoids false-positive matches on our own `grep` filter spawned in the pipe.
  ps -eo pid,etime,command 2>/dev/null \
    | awk 'NR>1 {
        cmd="";
        for(i=3;i<=NF;i++) cmd=cmd" "$i;
        sub(/^ /,"",cmd);
        bin=$3;
        n=split(bin,parts,"/");
        base=parts[n];
        if (base ~ /^(node|python|python3|ruby)$/) print $1"|"$2"|"cmd
      }' \
    | grep -Ev 'Claude\.app|Claude Helper|cleanup-tracker\.sh' \
    | sort -u
}

cmd_baseline() {
  # Idempotent: only write baseline once per session
  if [ -f "$BASELINE_FILE" ]; then
    return 0
  fi
  {
    echo "# CLAUDE SESSION BASELINE — $SID @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "## FILES"
    snapshot_files
    echo "## PROCS"
    snapshot_procs
  } > "$BASELINE_FILE"
}

cmd_audit() {
  if [ ! -f "$BASELINE_FILE" ]; then
    # No baseline → nothing to compare, don't block
    return 0
  fi

  # Extract baseline sections into temp files
  local baseline_files_file baseline_procs_file
  baseline_files_file=$(mktemp /tmp/claude-audit-bfiles-XXXX)
  baseline_procs_file=$(mktemp /tmp/claude-audit-bprocs-XXXX)
  trap 'rm -f "$baseline_files_file" "$baseline_procs_file"' RETURN

  awk '/^## FILES/{s="f";next} /^## PROCS/{s="p";next} /^#/{next} s=="f"{print}' "$BASELINE_FILE" > "$baseline_files_file"
  awk '/^## PROCS/{s="p";next} /^#/{next} s=="p"{print}' "$BASELINE_FILE" | awk -F'|' '{print $1}' > "$baseline_procs_file"

  local violations=0

  # New files/dirs not in baseline and not whitelisted
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    # Check whitelist
    if echo "$path" | grep -qE "$WHITELIST"; then
      continue
    fi
    # Check if it was in baseline
    if grep -qxF "$path" "$baseline_files_file" 2>/dev/null; then
      continue
    fi
    # New artifact — classify
    if [ -d "$path" ]; then
      echo "DIR|$path|created during session, not cleaned up"
    else
      echo "FILE|$path|created during session, not cleaned up"
    fi
    violations=$((violations + 1))
  done < <(snapshot_files)

  # New processes not in baseline (by PID). A PID that didn't exist at baseline
  # but exists now AND is a long-lived type → violation.
  while IFS='|' read -r pid etime cmd; do
    [ -z "$pid" ] && continue
    if grep -qxF "$pid" "$baseline_procs_file" 2>/dev/null; then
      continue
    fi
    # Skip our own audit helpers (short-lived)
    if echo "$cmd" | grep -qE 'cleanup-tracker\.sh|hook-helper\.sh|/bin/bash.*-c'; then
      continue
    fi
    echo "PROC|$pid|etime=$etime cmd=$cmd"
    violations=$((violations + 1))
  done < <(snapshot_procs)

  if [ "$violations" -gt 0 ]; then
    return 1
  fi
  return 0
}

case "$CMD" in
  baseline) cmd_baseline ;;
  audit)    cmd_audit ;;
  *)
    echo "usage: $0 {baseline|audit} <session_id>" >&2
    exit 2
    ;;
esac
