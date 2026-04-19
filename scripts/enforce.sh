#!/usr/bin/env bash
# Thin wrapper — each settings.json hook calls this with the event name.
# All dispatch lives in enforce.py, reading rules.json.
#
# settings.json wire-up:
#   { "type": "command", "command": "bash $HOME/.cylon/master/scripts/enforce.sh <event>" }
set -u
EVENT="${1:-}"
[ -z "$EVENT" ] && exit 0
BASE="${ENFORCE_BASE:-$(cd "$(dirname "$0")/.." && pwd)}"
PYENGINE="$BASE/scripts/enforce.py"
[ -f "$PYENGINE" ] || exit 0
exec python3 "$PYENGINE" "$EVENT"
