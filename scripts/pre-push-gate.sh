#!/usr/bin/env bash
# Anuki Pre-Push Gate — 4 mandatory checks before git push
# Triggers on: git push commands in Anuki directory
# Blocks if ANY gate fails
# English-only output (Anuki MVP is English)

set -euo pipefail

# Cleanup trap for orphaned processes and temp dirs
cleanup() {
  [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null && wait "$server_pid" 2>/dev/null || true
  [ -n "${acid_pid:-}" ] && kill "$acid_pid" 2>/dev/null && wait "$acid_pid" 2>/dev/null || true
  [ -d "${ACID_DIR:-}" ] && rm -rf "$ACID_DIR"
}
trap cleanup EXIT INT TERM

# Read stdin (Claude Code PreToolUse schema)
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')

# Only trigger on git push
if ! echo "$cmd" | grep -qE '^\s*git\s+push'; then
  exit 0  # Not a push, allow
fi

BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$BASEDIR" || exit 1

# Only trigger for Anuki repo (not other repos)
repo_name=$(basename "$BASEDIR")
if [ "$repo_name" != "anuki" ]; then
  exit 0
fi

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Helper: wait for health endpoint with polling
wait_for_health() {
  local port=$1
  local max_wait=${2:-20}
  for i in $(seq 1 "$max_wait"); do
    local status
    status=$(curl -sf "http://localhost:$port/api/health" 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true)
    if [ "$status" = "ok" ] || [ "$status" = "healthy" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Helper: find a free port
find_free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"
}

# Parse target branch for diff scope
target_branch=$(echo "$cmd" | grep -oE 'origin\s+\S+' | awk '{print $2}' || true)
target_branch=${target_branch:-main}

# Get changed files since last push (not just last commit)
changed_files=$(git diff --name-only "origin/$target_branch..HEAD" 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || true)
if [ -z "$changed_files" ]; then
  # No new commits to push — git will say "Everything up-to-date"
  echo "No changed files since origin/$target_branch — nothing to gate." >&2
  exit 0
fi

# ============================================================
# GATE 1: Turkish character scan
# ============================================================
echo "GATE 1: Turkish character scan..." >&2

# Scan changed files (exclude this script to avoid false positives from pattern list)
turkish_chars=$(echo "$changed_files" | grep -v 'pre-push-gate.sh' | xargs grep -rnE '[şŞğĞıİüÜöÖçÇ]' 2>/dev/null || true)
if [ -n "$turkish_chars" ]; then
  emit_deny "GATE 1 FAIL: Turkish characters detected in commit:
$turkish_chars

Fix: Remove Turkish characters, commit again."
fi

turkish_words=$(echo "$changed_files" | grep -v 'pre-push-gate.sh' | xargs grep -rnEi 'KIMLIK|KISILIK|MISYON|GUVENLIK|OPERASYON|ARACLARIN|YASAK' 2>/dev/null || true)
if [ -n "$turkish_words" ]; then
  emit_deny "GATE 1 FAIL: Turkish keywords detected in commit:
$turkish_words

Fix: Translate or remove Turkish keywords, commit again."
fi

echo "GATE 1: PASS — No Turkish content" >&2

# ============================================================
# GATE 2: Syntax check (changed JS files)
# ============================================================
echo "GATE 2: Syntax check..." >&2
while IFS= read -r file; do
  if [[ "$file" == *.js ]] && [ -f "$file" ]; then
    syntax_err=$(node -c "$file" 2>&1) || emit_deny "GATE 2 FAIL: Syntax error in $file

$syntax_err

Fix: Correct syntax errors, test with 'node -c $file', commit again."
  fi
done <<< "$changed_files"
echo "GATE 2: PASS — All changed files syntax-valid" >&2

# ============================================================
# GATE 3: Runtime test (local working copy, random port)
# ============================================================
echo "GATE 3: Runtime test..." >&2
if [ ! -f "$BASEDIR/src/index.js" ]; then
  emit_deny "GATE 3 FAIL: src/index.js not found. Cannot start server."
fi

GATE3_PORT=$(find_free_port)
echo "GATE 3: Using port $GATE3_PORT..." >&2

ANUKI_TEST_PORT=$GATE3_PORT node "$BASEDIR/src/index.js" >/dev/null 2>&1 &
server_pid=$!

if ! wait_for_health "$GATE3_PORT" 20; then
  emit_deny "GATE 3 FAIL: Health check failed on port $GATE3_PORT. Server did not start correctly.

Fix: Test locally with 'ANUKI_TEST_PORT=$GATE3_PORT node src/index.js', check logs, fix runtime errors, commit again."
fi

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
echo "GATE 3: PASS — Local runtime healthy (port $GATE3_PORT)" >&2

# ============================================================
# GATE 4: Fresh clone acid test (random port)
# ============================================================
echo "GATE 4: Fresh clone acid test..." >&2
ACID_DIR="/tmp/anuki-acid-$(date +%s)"

if ! git clone "$BASEDIR" "$ACID_DIR" >/dev/null 2>&1; then
  rm -rf "$ACID_DIR" 2>/dev/null || true
  emit_deny "GATE 4 FAIL: git clone failed."
fi

cd "$ACID_DIR" || emit_deny "GATE 4 FAIL: Cannot cd into acid test clone."

if ! npm install --silent >/dev/null 2>&1; then
  emit_deny "GATE 4 FAIL: npm install failed in fresh clone.

Fix: Check package.json, ensure dependencies are correct, commit again."
fi

if ! node -c src/index.js 2>/dev/null; then
  emit_deny "GATE 4 FAIL: src/index.js has syntax error in fresh clone."
fi

GATE4_PORT=$(find_free_port)
echo "GATE 4: Using port $GATE4_PORT..." >&2

ANUKI_TEST_PORT=$GATE4_PORT node src/index.js >/dev/null 2>&1 &
acid_pid=$!

if ! wait_for_health "$GATE4_PORT" 30; then
  emit_deny "GATE 4 FAIL: Fresh clone health check failed on port $GATE4_PORT. Fresh users pulling this commit will have a broken server.

Fix: Test with fresh clone, fix bootstrap issues, commit again."
fi

kill "$acid_pid" 2>/dev/null || true
wait "$acid_pid" 2>/dev/null || true
acid_pid=""
cd /tmp || true
rm -rf "$ACID_DIR"
ACID_DIR=""

echo "GATE 4: PASS — Fresh clone functional (port $GATE4_PORT)" >&2

# ============================================================
# ALL GATES PASSED
# ============================================================
echo "ALL 4 GATES PASSED — Push allowed" >&2
exit 0
