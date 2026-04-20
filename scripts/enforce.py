#!/usr/bin/env python3
"""Generic enforcement engine — data-driven hook runner.

The single source of truth for CYLON's hook-level enforcement now
lives in `rules.json`. `.claude/settings.local.json` wires each hook
event to a one-line wrapper that calls this engine; the engine reads
the manifest and dispatches every rule applicable to that event.

Rule schema (rules.json):
  {
    "rules": [
      {
        "id": "009",
        "name": "pkill-forbidden",
        "event": "PreToolUse",
        "matcher": "Bash",           # honoured by Claude via settings.json
        "when": { "command_regex": "(pkill|killall)\\s" },
        "then": { "action": "deny", "reason": "RULE 009 BLOCK: ..." },
        "enabled": true
      },
      {
        "id": "024_001",
        "name": "claim-vs-tool-trace",
        "event": "Stop",
        "plugin": "claim-verify.py"
      },
      {
        "id": "big-picture-inject",
        "event": "SessionStart",
        "inject": "docs/BIG-PICTURE.md",
        "label": "=== BIG-PICTURE methodology ==="
      }
    ]
  }

Rule kinds:
  declarative = has `when` + `then`  → engine evaluates regex + emits deny/warn
  plugin      = has `plugin`         → engine execs script, relays stdout + exit code
  inject      = has `inject`         → engine reads file and emits as additionalContext

Exit code:
  0 = allow (claude code proceeds)
  1 = the response/tool is blocked (stdout has the JSON payload claude parses)

Plugins contract:
  Receive JSON payload on stdin (same thing claude code piped to us).
  Emit hookSpecificOutput JSON on stdout when they want to deny/warn.
  Exit 0 = allow; exit 1 = block (engine relays).

Adding a new rule = append to rules.json. No settings.json edit needed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


# ── Paths ────────────────────────────────────────────────────────────────
BASE = Path(os.environ.get("ENFORCE_BASE", Path(__file__).resolve().parent.parent))
RULES_FILE = BASE / "rules.json"
PLUGINS_DIR = BASE / "scripts"


# ── Emitters ─────────────────────────────────────────────────────────────
def emit_deny_pretooluse(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def emit_deny_stop(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
        "decision": "block",
        "reason": reason,
    }))


def emit_additional_context(event: str, text: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": text,
        }
    }))


# ── Trigger matching ─────────────────────────────────────────────────────
def get_field(payload: dict, path: str):
    """Dotted-path accessor; returns '' if any segment missing."""
    cur = payload
    for part in path.split("."):
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(part)
        if cur is None:
            return ""
    return cur if isinstance(cur, str) else ""


def matches_when(rule: dict, payload: dict) -> bool:
    """All `when` conditions must hold (AND semantics)."""
    when = rule.get("when") or {}
    if not when:
        return True
    for key, pat in when.items():
        # IMPORTANT: check _not_regex BEFORE _regex — both suffixes end in
        # "_regex", so a naive endswith('_regex') test on `command_not_regex`
        # would strip 6 chars and misidentify field_key as "command_n".
        if key.endswith("_not_regex"):
            field_key = key[:-10]
            if field_key == "command":
                val = (payload.get("tool_input") or {}).get("command", "") if isinstance(payload, dict) else ""
            elif field_key == "file_path":
                val = (payload.get("tool_input") or {}).get("file_path", "") if isinstance(payload, dict) else ""
            else:
                val = payload.get(field_key, "") if isinstance(payload, dict) else ""
            if not isinstance(val, str):
                val = ""
            try:
                if re.search(pat, val):
                    return False  # negative match → rule does NOT fire
            except re.error:
                pass
            continue
        if key.endswith("_regex"):
            field_key = key[:-6]  # strip _regex
            if field_key == "tool_name":
                val = payload.get("tool_name", "") if isinstance(payload, dict) else ""
            elif field_key == "file_path":
                val = (payload.get("tool_input") or {}).get("file_path", "") if isinstance(payload, dict) else ""
            elif field_key == "command":
                val = (payload.get("tool_input") or {}).get("command", "") if isinstance(payload, dict) else ""
            elif field_key == "content":
                ti = payload.get("tool_input") or {}
                val = ti.get("new_string") or ti.get("content") or ""
            elif "." in field_key:
                val = get_field(payload, field_key)
            else:
                val = payload.get(field_key, "") if isinstance(payload, dict) else ""
            if not isinstance(val, str):
                val = ""
            try:
                if not re.search(pat, val):
                    return False
            except re.error:
                return False
        elif key.endswith("_not_regex"):
            field_key = key[:-10]
            if field_key == "command":
                val = (payload.get("tool_input") or {}).get("command", "") if isinstance(payload, dict) else ""
            else:
                val = payload.get(field_key, "") if isinstance(payload, dict) else ""
            if not isinstance(val, str):
                val = ""
            try:
                if re.search(pat, val):
                    return False
            except re.error:
                pass
    return True


# ── Evaluators ───────────────────────────────────────────────────────────
def eval_declarative(rule: dict, payload: dict, event: str) -> int:
    if not matches_when(rule, payload):
        return 0
    action = (rule.get("then") or {}).get("action", "allow")
    reason = (rule.get("then") or {}).get("reason") or rule.get("name", "")
    if action == "deny":
        if event == "PreToolUse":
            emit_deny_pretooluse(reason)
            return 1
        if event == "Stop":
            emit_deny_stop(reason)
            return 1
        emit_additional_context(event, f"WARN [{rule.get('id', '?')}]: {reason}")
        return 0
    if action == "warn":
        emit_additional_context(event, f"[{rule.get('id', '?')}] {reason}")
        return 0
    return 0


def eval_plugin(rule: dict, payload: dict, event: str, stdin_raw: str) -> int:
    plugin = rule.get("plugin", "").strip()
    if not plugin:
        return 0
    parts = plugin.split()
    script = PLUGINS_DIR / parts[0]
    args = parts[1:]
    if not script.exists() or not os.access(script, os.X_OK):
        return 0
    try:
        proc = subprocess.run(
            [str(script), *args],
            input=stdin_raw,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return 0
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    return proc.returncode


def eval_inject(rule: dict, event: str) -> int:
    target = rule.get("inject", "")
    if not target:
        return 0
    path = BASE / target
    if not path.exists():
        return 0
    try:
        content = path.read_text()
    except Exception:
        return 0
    label = rule.get("label", f"=== {target} ===")
    emit_additional_context(event, f"\n{label}\n{content}")
    return 0


# ── Main ─────────────────────────────────────────────────────────────────
MAINTENANCE = os.environ.get("ANUKI_MAINTENANCE") == "1"


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    event = sys.argv[1]
    stdin_raw = sys.stdin.read()
    try:
        payload = json.loads(stdin_raw) if stdin_raw.strip() else {}
    except Exception:
        payload = {}

    if not RULES_FILE.exists():
        return 0
    try:
        catalogue = json.loads(RULES_FILE.read_text())
    except Exception as e:
        print(f"enforce.py: rules.json parse error: {e}", file=sys.stderr)
        return 0

    rules = catalogue.get("rules", [])
    blocked = False
    for rule in rules:
        if rule.get("event") != event:
            continue
        if rule.get("enabled") is False:
            continue
        if rule.get("plugin"):
            ec = eval_plugin(rule, payload, event, stdin_raw)
        elif rule.get("inject"):
            ec = eval_inject(rule, event)
        else:
            ec = eval_declarative(rule, payload, event)
        if ec == 1:
            if MAINTENANCE:
                rid = rule.get("id", "?")
                print(f"[MAINTENANCE] Would block rule {rid} — allowing", file=sys.stderr)
                continue  # log but don't block
            blocked = True
            break  # first deny wins; downstream rules skipped
    return 1 if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
