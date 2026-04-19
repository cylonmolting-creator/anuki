#!/usr/bin/env python3
"""Claim-vs-tool-trace verifier (Rule 024 + Rule 001).

Dynamic enforcement: when the assistant's response makes an action claim
("fixed X", "pushed", "tested Y"), verify the transcript has a matching
tool_use in the current turn. If any claim class has no supporting tool
trace, emit a block message listing the unsupported claims.

Not a static keyword filter — each claim CATEGORY is mapped to the set
of tool usage signatures that would justify it. New claim verbs can be
added to the CLAIM_CLASSES table; nothing else changes.

Usage:
    claim-verify.py <transcript_path>
    exit 0 = clean, exit 1 = block (reason on stdout)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Each claim class: (regex for past-tense claim, predicate over recent tool_uses)
# The predicate receives a list of (tool_name, tool_input) tuples from the
# current turn and must return True if the claim is supported.


def has_tool(uses, name: str) -> bool:
    return any(t == name for t, _ in uses)


def has_bash_matching(uses, pat: re.Pattern) -> bool:
    for t, inp in uses:
        if t == "Bash":
            cmd = (inp or {}).get("command", "") if isinstance(inp, dict) else ""
            if pat.search(cmd or ""):
                return True
    return False


CLAIM_CLASSES = [
    (
        "edit/write",
        re.compile(
            r"\b(?:fixed|patched|repaired|resolved|added|wrote|created|implemented|"
            r"built|generated|updated|refactored|replaced|introduced|modified|edited)\b",
            re.IGNORECASE,
        ),
        lambda uses: has_tool(uses, "Edit")
        or has_tool(uses, "Write")
        or has_tool(uses, "NotebookEdit"),
    ),
    (
        "git-push",
        re.compile(r"\bpushed\b(?! back)", re.IGNORECASE),
        lambda uses: has_bash_matching(uses, re.compile(r"\bgit\s+push\b")),
    ),
    (
        "git-commit",
        re.compile(r"\bcommitted\b", re.IGNORECASE),
        lambda uses: has_bash_matching(uses, re.compile(r"\bgit\s+commit\b")),
    ),
    (
        "deploy",
        re.compile(r"\b(?:deployed|shipped|released|kickstarted)\b", re.IGNORECASE),
        lambda uses: has_bash_matching(
            uses,
            re.compile(
                r"\b(?:cp|launchctl|kickstart|safe-restart|deploy|rsync|scp|docker\s+push)\b"
            ),
        ),
    ),
    (
        "run/test",
        re.compile(
            r"\b(?:ran|tested|verified|validated|benchmarked|measured|executed)\b",
            re.IGNORECASE,
        ),
        lambda uses: any(t == "Bash" for t, _ in uses)
        or any(t == "Grep" for t, _ in uses),
    ),
    (
        "read/inspect",
        re.compile(
            r"\b(?:read|examined|inspected|searched|grep(?:p?ed)?|scanned)\b",
            re.IGNORECASE,
        ),
        lambda uses: has_tool(uses, "Read")
        or has_tool(uses, "Grep")
        or has_bash_matching(uses, re.compile(r"\b(?:grep|cat|head|tail|less|find)\b")),
    ),
    (
        "kill/remove",
        re.compile(
            r"\b(?:killed|terminated|stopped|removed|deleted|unlinked|cleaned)\b",
            re.IGNORECASE,
        ),
        lambda uses: has_bash_matching(
            uses,
            re.compile(r"\b(?:kill|pkill|unlink|rmdir|rm\s|find.*-delete)\b"),
        )
        or has_tool(uses, "Edit")
        or has_tool(uses, "Write"),
    ),
]


def parse_turn_tools(transcript_path: Path) -> list[tuple[str, dict]]:
    """Return list of (tool_name, tool_input) from the current turn.

    Current turn = everything after the last user message in the transcript.
    This matches what the Stop hook sees: the assistant's work since the
    user's latest prompt.
    """
    if not transcript_path.exists():
        return []
    tool_uses: list[tuple[str, dict]] = []
    last_user_idx = -1

    lines = transcript_path.read_text(errors="ignore").splitlines()
    # First pass: find index of last user message
    for i, ln in enumerate(lines):
        try:
            obj = json.loads(ln)
        except Exception:
            continue
        msg = obj.get("message", {}) if isinstance(obj, dict) else {}
        if msg.get("role") == "user":
            last_user_idx = i

    # Second pass: gather tool_use blocks after last_user_idx
    for ln in lines[last_user_idx + 1 :]:
        try:
            obj = json.loads(ln)
        except Exception:
            continue
        msg = obj.get("message", {}) if isinstance(obj, dict) else {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                tool_uses.append((block.get("name", ""), block.get("input") or {}))
    return tool_uses


def get_assistant_response(transcript_path: Path) -> str:
    """Return the text of the latest assistant message (what the user will see)."""
    if not transcript_path.exists():
        return ""
    last_text = ""
    for ln in transcript_path.read_text(errors="ignore").splitlines():
        try:
            obj = json.loads(ln)
        except Exception:
            continue
        msg = obj.get("message", {}) if isinstance(obj, dict) else {}
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            last_text = content
        elif isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            if parts:
                last_text = "\n".join(parts)
    return last_text


def main():
    if len(sys.argv) < 2:
        print("usage: claim-verify.py <transcript_path>", file=sys.stderr)
        return 2
    tp = Path(sys.argv[1])
    response = get_assistant_response(tp)
    if not response:
        return 0

    tool_uses = parse_turn_tools(tp)

    failures = []
    for label, pattern, predicate in CLAIM_CLASSES:
        if not pattern.search(response):
            continue  # claim class not present
        if predicate(tool_uses):
            continue  # claim supported by a matching tool_use
        # Extract a short sample of the offending phrase
        m = pattern.search(response)
        phrase = m.group(0) if m else label
        failures.append((label, phrase))

    if not failures:
        return 0

    lines = [
        "RULE 024 / 001 CLAIM AUDIT: the response makes action claims that",
        "the current turn's tool usage does not support:",
        "",
    ]
    for label, phrase in failures:
        lines.append(f"  - claim class '{label}': phrase '{phrase}' — no matching tool_use this turn")
    lines.append("")
    lines.append(
        "Either back each claim with a real tool call (Edit/Write/Bash/Grep as"
        " appropriate) in this turn, or rewrite the response to drop the claim."
    )
    print("\n".join(lines))
    return 1


if __name__ == "__main__":
    sys.exit(main())
