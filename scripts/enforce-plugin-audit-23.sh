#!/usr/bin/env bash
# AUDIT_23: block Stop if the last assistant message contains a TR or EN
# performance/hedge claim without matching evidence (file:line, grep, PASS,
# benchmark, verified, etc.).
set -u
input=$(cat)
tp=$(echo "$input" | jq -r '.transcript_path // empty')
[ -z "$tp" ] || [ ! -f "$tp" ] && exit 0
msg=$(python3 -c "
import json
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
has_claim=$(echo "$msg" | grep -ciE 'kullanilmiyor|kullanılmıyor|dead code|gereksiz|bulunamadi|bulunamadı|mevcut degil|mevcut değil|artacak|\bartar\b|artıyor|azalacak|\bazalır\b|azalıyor|\byükselir\b|yükselecek|ivme kazanır|daha iyi|daha hizli|daha hızlı|optimize eder|muhtemelen|sanırım|tahminimce|söz konusu|kat hızlı|kat daha|% .* artar|% .* azalır|[0-9]+x daha|will (increase|decrease|improve|speed up|slow down|be (faster|slower|better|worse))|should be (faster|slower|better|worse|improved)|would be (faster|slower|better|worse)|significantly (more|less|better|faster|slower)|(modest|noticeable|considerable|observed) (improvement|gain|gains|increase)|seemingly (faster|better|slower)|apparently (faster|better|slower)|[0-9]+x (faster|slower|better)|(probably|presumably|likely|i think|i believe|i guess)|\boptimizes\b' || true)
has_evidence=$(echo "$msg" | grep -cE '\.[a-z]{1,4}:[0-9]+|grep.*src/|PASS|\bOK\b|SUCCESS|dogruland|doğrulandı|verified|confirmed|curl.*→.*200|took [0-9]|[0-9]+ms|benchmark|measured|md5sum|runtime' || true)
if [ "$has_claim" -gt 0 ] && [ "$has_evidence" -eq 0 ]; then
  reason="AUDIT_23: Cevabinda kanitlanmamis iddia tespit edildi. Sayisal tahmin, performans iddiasi veya karsilastirma icin olcum/benchmark/file:line/test sonucu sunma zorunlu."
  jq -nc --arg msg "$reason" '{hookSpecificOutput:{hookEventName:"Stop",permissionDecision:"deny",permissionDecisionReason:$msg},decision:"block",reason:$msg}'
  exit 1
fi
exit 0
