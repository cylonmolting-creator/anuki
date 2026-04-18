#!/usr/bin/env bash
# Anuki Hook Validator — Tests all Stop hooks in settings.json for correctness
#
# Validates:
#   1. JSON output schema (decision: "approve"|"block", NOT "allow")
#   2. No direct jq read of last_assistant_message from stdin (must use transcript_path)
#   3. hook-helper.sh usage (recommended)
#   4. Syntax errors in hook commands
#
# Usage:
#   bash scripts/validate-hooks.sh                     # validate .claude/settings.json
#   bash scripts/validate-hooks.sh /path/to/file.json  # validate specific file

set -euo pipefail

# Auto-detect project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SETTINGS_FILE="${1:-$PROJECT_DIR/.claude/settings.json}"
PASS=0
FAIL=0
WARN=0

red()    { printf '\033[31m%s\033[0m\n' "$1"; }
green()  { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

pass() { PASS=$((PASS + 1)); green "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); red   "  FAIL: $1"; }
warn() { WARN=$((WARN + 1)); yellow "  WARN: $1"; }

echo "=== Anuki Hook Validator ==="
echo "Settings: $SETTINGS_FILE"
echo ""

if [ ! -f "$SETTINGS_FILE" ]; then
  fail "Settings file not found: $SETTINGS_FILE"
  exit 1
fi

hook_count=$(jq -r '.hooks.Stop[0].hooks | length' "$SETTINGS_FILE" 2>/dev/null || echo 0)
if [ "$hook_count" -eq 0 ]; then
  warn "No Stop hooks found"
  exit 0
fi

echo "Found $hook_count Stop hook(s)"
echo ""

for i in $(seq 0 $((hook_count - 1))); do
  hook_cmd=$(jq -r ".hooks.Stop[0].hooks[$i].command" "$SETTINGS_FILE")
  hook_type=$(jq -r ".hooks.Stop[0].hooks[$i].type" "$SETTINGS_FILE")
  hook_name=$(echo "$hook_cmd" | head -1 | sed 's/^# *//')
  echo "--- Hook $((i + 1)): $hook_name ---"

  # Check 1: Must be command type
  if [ "$hook_type" = "command" ]; then
    pass "Type is 'command'"
  else
    fail "Type is '$hook_type' — only 'command' works in -p mode"
  fi

  # Check 2: No direct read of last_assistant_message from stdin
  if echo "$hook_cmd" | grep -qE 'jq.*last_assistant_message|\.last_assistant_message'; then
    if echo "$hook_cmd" | grep -qE 'transcript_path|hook-helper'; then
      pass "Reads last_assistant_message via transcript_path (not stdin)"
    else
      fail "Reads .last_assistant_message directly from stdin — field does NOT exist! Use transcript_path or hook-helper.sh"
    fi
  else
    pass "No direct last_assistant_message read from stdin"
  fi

  # Check 3: decision value correctness
  if echo "$hook_cmd" | grep -qE '"decision"[[:space:]]*:[[:space:]]*"allow"'; then
    fail "Uses decision:'allow' — must be 'approve' or 'block'"
  elif echo "$hook_cmd" | grep -qE '"decision"[[:space:]]*:[[:space:]]*"(approve|block)"'; then
    pass "Decision values are valid (approve/block)"
  else
    if echo "$hook_cmd" | grep -qE 'decision.*allow'; then
      fail "Uses decision:'allow' (escaped) — must be 'approve' or 'block'"
    elif echo "$hook_cmd" | grep -qE 'decision.*(approve|block)'; then
      pass "Decision values are valid (approve/block, escaped)"
    elif echo "$hook_cmd" | grep -qE 'emit_block|emit_approve'; then
      pass "Decision values delegated to hook-helper.sh (validated there)"
    else
      warn "Could not verify decision values — manual check recommended"
    fi
  fi

  # Check 4: hook-helper.sh usage
  if echo "$hook_cmd" | grep -q 'hook-helper.sh'; then
    pass "Uses hook-helper.sh (recommended)"
  else
    warn "Does not use hook-helper.sh — consider using shared helper for consistency"
  fi

  # Check 5: stop_hook_active guard
  if echo "$hook_cmd" | grep -qE 'stop_hook_active|check_hook_active'; then
    pass "Has stop_hook_active infinite loop guard"
  else
    warn "No stop_hook_active guard — risk of infinite loop"
  fi

  # Check 6: Bash syntax check
  syntax_result=$(bash -n <(echo "$hook_cmd") 2>&1)
  if [ $? -eq 0 ]; then
    pass "Bash syntax valid"
  else
    fail "Bash syntax error: $syntax_result"
  fi

  echo ""
done

echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  red "HOOKS HAVE FAILURES — fix before deploying"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  yellow "Hooks valid but have warnings — review recommended"
  exit 0
else
  green "All hooks valid"
  exit 0
fi
