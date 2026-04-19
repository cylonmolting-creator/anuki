#!/usr/bin/env bash
# Rule 012 record: delegate to the existing edit-verify-tracker.sh after
# extracting session_id from stdin. Wrapper exists so the manifest can
# reference one plugin per rule without needing multiple arguments.
set -u
BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "default"')
echo "$input" | "$BASEDIR/scripts/edit-verify-tracker.sh" record "$sid"
