#!/usr/bin/env bash
# PK-GUARD: block Stop if the last assistant message contains a 64-char
# hex pattern (private key leak). Reads the transcript's last assistant text.
set -u
input=$(cat)
tp=$(echo "$input" | jq -r '.transcript_path // empty')
[ -z "$tp" ] || [ ! -f "$tp" ] && exit 0
# Extract the last assistant text content via python (safer than jq multi-step)
msg=$(python3 -c "
import json, sys
last = ''
try:
    for line in open('$tp', errors='ignore'):
        try: obj = json.loads(line)
        except: continue
        m = obj.get('message') if isinstance(obj, dict) else None
        if not isinstance(m, dict): continue
        if m.get('role') != 'assistant': continue
        c = m.get('content')
        if isinstance(c, str): last = c
        elif isinstance(c, list):
            parts=[]
            for b in c:
                if isinstance(b, dict) and b.get('type')=='text':
                    parts.append(b.get('text',''))
            if parts: last='\n'.join(parts)
    print(last)
except: pass
" 2>/dev/null)
[ -z "$msg" ] && exit 0
if echo "$msg" | grep -qE '0x[a-fA-F0-9]{64}'; then
  reason="PK-GUARD: Response contains a 64-char hex pattern (private key). Never print PKs in chat — they get transmitted to Anthropic API. Redact and give the user a local sqlite3 command instead."
  jq -nc --arg msg "$reason" '{hookSpecificOutput:{hookEventName:"Stop",permissionDecision:"deny",permissionDecisionReason:$msg},decision:"block",reason:$msg}'
  exit 1
fi
exit 0
