#!/usr/bin/env python3
"""Generic enforcement engine — data-driven hook runner.

The single source of truth for Anuki's hook-level enforcement now
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
from datetime import datetime, timezone
from pathlib import Path


# ── Paths ────────────────────────────────────────────────────────────────
BASE = Path(os.environ.get("ENFORCE_BASE", Path(__file__).resolve().parent.parent))
RULES_FILE = BASE / "rules.json"
PLUGINS_DIR = BASE / "scripts"
HOOK_LOG = BASE / "logs" / "hook-decisions.jsonl"
HOOK_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB — truncate when exceeded


# ── Decision Logger ──────────────────────────────────────────────────────
def log_decision(rule_id: str, rule_name: str, event: str, decision: str,
                 reason: str = "", tool: str = "", target: str = "") -> None:
    """Append one JSONL entry to hook-decisions.jsonl for every rule evaluation."""
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "rule_id": rule_id,
            "rule_name": rule_name,
            "event": event,
            "decision": decision,  # "block", "allow", "warn", "skip", "inject"
            "reason": reason[:200] if reason else "",
            "tool": tool,
            "target": target[:200] if target else "",
        }
        HOOK_LOG.parent.mkdir(parents=True, exist_ok=True)
        # Size check — truncate if over limit (keep last 50% of file)
        if HOOK_LOG.exists():
            try:
                sz = HOOK_LOG.stat().st_size
                if sz > HOOK_LOG_MAX_BYTES:
                    lines = HOOK_LOG.read_text().splitlines()
                    half = lines[len(lines) // 2:]
                    HOOK_LOG.write_text("\n".join(half) + "\n")
            except Exception:
                pass
        with open(HOOK_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # logging must never break enforcement


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
    rid = rule.get("id", "?")
    rname = rule.get("name", "")
    tool = payload.get("tool_name", "") if isinstance(payload, dict) else ""
    ti = payload.get("tool_input", {}) if isinstance(payload, dict) else {}
    target = ti.get("file_path") or ti.get("command", "")[:100] or ""
    if not matches_when(rule, payload):
        log_decision(rid, rname, event, "allow", "when-not-matched", tool, target)
        return 0
    action = (rule.get("then") or {}).get("action", "allow")
    reason = (rule.get("then") or {}).get("reason") or rule.get("name", "")
    if action == "deny":
        log_decision(rid, rname, event, "block", reason, tool, target)
        if event == "PreToolUse":
            emit_deny_pretooluse(reason)
            return 1
        if event == "Stop":
            emit_deny_stop(reason)
            return 1
        emit_additional_context(event, f"WARN [{rule.get('id', '?')}]: {reason}")
        return 0
    if action == "warn":
        log_decision(rid, rname, event, "warn", reason, tool, target)
        emit_additional_context(event, f"[{rule.get('id', '?')}] {reason}")
        return 0
    log_decision(rid, rname, event, "allow", "action=allow", tool, target)
    return 0


def eval_plugin(rule: dict, payload: dict, event: str, stdin_raw: str) -> int:
    rid = rule.get("id", "?")
    rname = rule.get("name", "")
    tool = payload.get("tool_name", "") if isinstance(payload, dict) else ""
    ti = payload.get("tool_input", {}) if isinstance(payload, dict) else {}
    target = ti.get("file_path") or ti.get("command", "")[:100] or ""
    plugin = rule.get("plugin", "").strip()
    if not plugin:
        return 0
    parts = plugin.split()
    script = PLUGINS_DIR / parts[0]
    args = parts[1:]
    if not script.exists() or not os.access(script, os.X_OK):
        log_decision(rid, rname, event, "skip", f"plugin not found: {parts[0]}", tool, target)
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
        log_decision(rid, rname, event, "skip", "plugin timeout (10s)", tool, target)
        return 0
    decision = "block" if proc.returncode == 1 else "allow"
    log_decision(rid, rname, event, decision, proc.stdout[:200] if proc.stdout else "", tool, target)
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    return proc.returncode


def eval_inject(rule: dict, event: str) -> int:
    rid = rule.get("id", "?")
    rname = rule.get("name", "")
    target = rule.get("inject", "")
    if not target:
        return 0
    inject_path = BASE / target
    if not inject_path.exists():
        log_decision(rid, rname, event, "skip", f"inject file not found: {target}")
        return 0
    try:
        content = inject_path.read_text()
    except Exception:
        log_decision(rid, rname, event, "skip", f"inject file read error: {target}")
        return 0
    label = rule.get("label", f"=== {target} ===")
    emit_additional_context(event, f"\n{label}\n{content}")
    log_decision(rid, rname, event, "inject", f"injected {len(content)} chars from {target}")
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
