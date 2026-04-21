#!/usr/bin/env bash
# Anuki Hook Helper — Shared functions for Claude Code Stop hooks
# All hooks MUST source this file for consistent behavior.
#
# Usage in settings.json hook command:
#   source "$BASEDIR/scripts/hook-helper.sh" && your_logic_here
#
# Available functions:
#   get_last_message     — Extracts last assistant text from transcript JSONL
#   emit_block "reason"  — Outputs valid block JSON
#   emit_approve "ctx"   — Outputs valid approve JSON (optional additionalContext)
#   hook_stdin           — Reads and caches stdin JSON (call once at hook start)
#
# IMPORTANT: Claude Code Stop hook stdin schema (verified 2026-04-18):
#   {session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active}
#   There is NO last_assistant_message field — read from transcript_path instead.
#
# IMPORTANT: Claude Code Stop hook output schema:
#   decision: "approve" | "block" (NOT "allow"!)
#   reason: string (required for "block")
#   additionalContext: string (optional, shown as system context)

# --- Globals ---
_HOOK_STDIN=""
_HOOK_TRANSCRIPT_PATH=""
_HOOK_ACTIVE=""
_LAST_MSG_CACHE=""

# --- Read stdin once (must be called first) ---
hook_stdin() {
  _HOOK_STDIN=$(cat)
  _HOOK_TRANSCRIPT_PATH=$(echo "$_HOOK_STDIN" | jq -r '.transcript_path // empty')
  _HOOK_ACTIVE=$(echo "$_HOOK_STDIN" | jq -r '.stop_hook_active // false')
}

# --- Guard: skip if this is a hook-triggered response (infinite loop prevention) ---
check_hook_active() {
  if [ "$_HOOK_ACTIVE" = "true" ]; then
    exit 0
  fi
}

# --- Extract last assistant message text from transcript JSONL ---
get_last_message() {
  if [ -n "$_LAST_MSG_CACHE" ]; then
    echo "$_LAST_MSG_CACHE"
    return
  fi

  if [ -z "$_HOOK_TRANSCRIPT_PATH" ] || [ ! -f "$_HOOK_TRANSCRIPT_PATH" ]; then
    _LAST_MSG_CACHE=""
    echo ""
    return
  fi

  # Read last 50 lines, reverse (tail -r on macOS, tac on Linux)
  _LAST_MSG_CACHE=$(
    tail -50 "$_HOOK_TRANSCRIPT_PATH" 2>/dev/null \
    | if command -v tac >/dev/null 2>&1; then tac; else tail -r; fi \
    | while IFS= read -r line; do
        msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
        if [ "$msg_type" = "assistant" ]; then
          echo "$line" | jq -r '
            .message.content[]?
            | select(.type == "text")
            | .text
          ' 2>/dev/null
          break
        fi
      done
  )
  echo "$_LAST_MSG_CACHE"
}

# --- Emit block decision (valid schema) ---
emit_block() {
  local reason="$1"
  local escaped_reason
  escaped_reason=$(printf '%s' "$reason" | jq -Rs '.' | sed 's/^"//;s/"$//')
  printf '{"decision":"block","reason":"%s"}\n' "$escaped_reason"
}

# --- Emit approve decision (valid schema) ---
emit_approve() {
  local context="$1"
  if [ -z "$context" ]; then
    return
  fi
  local escaped_context
  escaped_context=$(printf '%s' "$context" | jq -Rs '.' | sed 's/^"//;s/"$//')
  printf '{"decision":"approve","additionalContext":"%s"}\n' "$escaped_context"
}

# --- Self-test mode (run with --test flag) ---
if [ "$1" = "--test" ]; then
  echo "=== hook-helper.sh self-test ==="

  # Test emit_block
  result=$(emit_block "test reason")
  expected='{"decision":"block","reason":"test reason"}'
  if [ "$result" = "$expected" ]; then
    echo "PASS: emit_block"
  else
    echo "FAIL: emit_block — got: $result"
  fi

  # Test emit_approve with context
  result=$(emit_approve "test context")
  expected='{"decision":"approve","additionalContext":"test context"}'
  if [ "$result" = "$expected" ]; then
    echo "PASS: emit_approve with context"
  else
    echo "FAIL: emit_approve — got: $result"
  fi

  # Test emit_approve without context (should be empty)
  result=$(emit_approve "")
  if [ -z "$result" ]; then
    echo "PASS: emit_approve without context (silent)"
  else
    echo "FAIL: emit_approve without context — got: $result"
  fi

  # Test schema keywords
  all_output=$(emit_block "x"; emit_approve "y")
  if echo "$all_output" | grep -q '"allow"' 2>/dev/null; then
    echo "FAIL: found 'allow' in output — must use 'approve'"
  else
    echo "PASS: no 'allow' in output"
  fi

  echo "=== self-test complete ==="
fi
