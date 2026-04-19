#!/usr/bin/env bash
# Anuki E2E SAFE RUNNER
#
# Wraps `npx playwright test` with three safety layers so tests cannot
# silently corrupt real agent state:
#
#   1. Pre-test backup — calls /api/backup/create. If tests misbehave,
#      the user has a point-in-time rollback.
#   2. Soul checksum snapshot — MD5 of every workspace/*/soul/*.md and *.txt
#      captured before tests run. After tests, we diff. Any mismatch =>
#      FAIL LOUDLY, the run is not declared green even if Playwright
#      reports all-pass.
#   3. Disposable-workspace discipline — tests must only act on workspaces
#      whose name starts with "e2e-" (enforced by each spec), and this
#      wrapper deletes any lingering e2e-* workspaces at the end.
#
# Exit codes:
#   0 — tests passed AND soul snapshot unchanged AND cleanup OK
#   1 — Playwright failures
#   2 — soul snapshot mismatch (CRITICAL: real data touched)
#   3 — pre-test setup failure

set -euo pipefail

BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
SNAP_BEFORE="/tmp/anuki-e2e-soul-before-$$.md5"
SNAP_AFTER="/tmp/anuki-e2e-soul-after-$$.md5"
TOKEN="${ANUKI_AUTH_TOKEN:-}"
BASE_URL="${ANUKI_BASE_URL:-http://localhost:3000}"

cleanup() {
  local ec=$?
  for f in "$SNAP_BEFORE" "$SNAP_AFTER"; do
    [ -f "$f" ] && unlink "$f" 2>/dev/null || true
  done
  # Sweep e2e-* workspaces tests may have left behind
  if command -v jq >/dev/null 2>&1; then
    local hdr=()
    [ -n "$TOKEN" ] && hdr=(-H "x-auth-token: $TOKEN")
    curl -s "${hdr[@]}" "$BASE_URL/api/workspaces" 2>/dev/null \
      | jq -r '.workspaces // . | if type=="array" then .[] else empty end | select((.name // "") | startswith("e2e-")) | .id' 2>/dev/null \
      | while read -r id; do
          [ -z "$id" ] && continue
          echo "  [cleanup] removing leftover e2e workspace: $id" >&2
          curl -s "${hdr[@]}" -X DELETE \
            "$BASE_URL/api/workspaces/$id?force=true" >/dev/null 2>&1 || true
        done
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

echo "═══ Gate 1/3 — Pre-test backup ═══"
hdr_args=()
[ -n "$TOKEN" ] && hdr_args=(-H "x-auth-token: $TOKEN")
backup_resp=$(curl -s -X POST -H "Content-Type: application/json" \
  "${hdr_args[@]}" "$BASE_URL/api/backup/create" -d '{}' 2>/dev/null || true)
backup_path=$(echo "$backup_resp" | jq -r '.path // .filename // empty' 2>/dev/null || echo "")
if [ -n "$backup_path" ]; then
  echo "  backup: $backup_path"
else
  echo "  backup endpoint unavailable or returned no path — continuing without rollback safety"
fi

echo ""
echo "═══ Gate 2/3 — Soul checksum snapshot (before) ═══"
: > "$SNAP_BEFORE"
find "$BASEDIR/workspace" -type f \( -name "*.md" -o -name "*.txt" \) \
  -path "*/soul/*" 2>/dev/null \
  | sort \
  | while read -r f; do
      md5 -q "$f" 2>/dev/null | awk -v p="$f" '{printf "%s  %s\n", $1, p}'
    done >> "$SNAP_BEFORE"
before_count=$(wc -l < "$SNAP_BEFORE" | tr -d ' ')
echo "  snapshot: $before_count soul files"

echo ""
echo "═══ Playwright test run ═══"
cd "$BASEDIR"
play_ec=0
npx playwright test "$@" || play_ec=$?

echo ""
echo "═══ Gate 3/3 — Soul checksum verification (after) ═══"
: > "$SNAP_AFTER"
find "$BASEDIR/workspace" -type f \( -name "*.md" -o -name "*.txt" \) \
  -path "*/soul/*" 2>/dev/null \
  | sort \
  | while read -r f; do
      md5 -q "$f" 2>/dev/null | awk -v p="$f" '{printf "%s  %s\n", $1, p}'
    done >> "$SNAP_AFTER"
after_count=$(wc -l < "$SNAP_AFTER" | tr -d ' ')
echo "  post-run: $after_count soul files"

if ! diff -q "$SNAP_BEFORE" "$SNAP_AFTER" >/dev/null 2>&1; then
  echo ""
  echo "  !!! CRITICAL: SOUL FILES CHANGED DURING TEST RUN !!!"
  echo ""
  diff "$SNAP_BEFORE" "$SNAP_AFTER" | head -40
  echo ""
  if [ -n "$backup_path" ]; then
    echo "  Backup available at: $backup_path"
  fi
  exit 2
fi

echo "  OK — soul files unchanged ✓"

if [ "$play_ec" -ne 0 ]; then
  echo ""
  echo "Playwright failed (exit=$play_ec) — soul files still untouched."
  exit "$play_ec"
fi

echo ""
echo "═══ All green ═══"
