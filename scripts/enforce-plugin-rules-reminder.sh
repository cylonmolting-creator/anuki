#!/usr/bin/env bash
# UserPromptSubmit: surface the active enforced rules in a short reminder
# so each prompt starts with them in visible context.
set -u
cat <<'TEXT' | jq -Rsc '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:.}}'
ENFORCED RULES (rules.json manifest, scripts/enforce.py engine):
 - 005 dynamic-first: hardcoded count (=== 2+) → BLOCK on Edit
 - 007 sandbox-first: master src/ + public/ direkt edit → BLOCK (sandbox zorunlu)
 - 008 safe-restart: launchctl kickstart → BLOCK (safe-restart API kullan)
 - 009 pkill/killall → BLOCK
 - 010 destructive real-ID DELETE/PUT/rm-rf → BLOCK
 - 011 soul vs runtime: soul edit + recent error → WARN
 - 012 edit-verify: Edit sonrası disk-grep fail → Stop BLOCK
 - 013 stack-patch: 5+ edit aynı dosyaya → BLOCK
 - 014 Anthropic SDK import → BLOCK
 - 020 read-before-edit: Read yapmadan Edit → BLOCK
 - 021 cleanup: session artifact bırakma → Stop BLOCK
 - 023 (audit-23) kanıtsız perf/hedge claim → Stop BLOCK
 - 025 git push öncesi runtime verify → BLOCK
 - PK-GUARD: 64-char hex response'a girerse → Stop BLOCK
Rule ekleme/değiştirme: rules.json'u düzenle. Engine otomatik iterate eder.
TEXT
exit 0
