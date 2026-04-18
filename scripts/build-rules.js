#!/usr/bin/env node
/**
 * Anuki Rule Generator — build-rules.js
 *
 * Reads: <project>/rules/*.md (SSOT rule files)
 *        <project>/data/workspaces.json (agent -> tags map)
 *
 * Writes (between markers):
 *   - <project>/workspace/<id>/soul/SAFETY.md   (per-agent)
 *   - <project>/.claude/settings.json            (hook enforcement)
 *
 * Generates:
 *   - PreToolUse hooks (hard-deny rules)
 *   - PostToolUse hooks (read tracker for must_read_before_edit)
 *   - Stop hooks (response-level audit for unverified claims)
 *   - UserPromptSubmit hooks (rule reminders)
 *
 * Idempotent: re-runs produce identical output.
 *
 * Usage:
 *   node scripts/build-rules.js           # apply changes
 *   node scripts/build-rules.js --check   # dry-run, show what would change
 *   node scripts/build-rules.js --quiet   # apply, suppress per-file output
 */

const fs = require('fs');
const path = require('path');

/**
 * Simple YAML frontmatter parser — no external dependency needed.
 * Handles the subset used in rule files: strings, arrays, booleans.
 */
function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split('\n');
  let currentKey = null;

  for (const line of lines) {
    // Array item continuation: "  - value"
    const arrayItem = line.match(/^\s+-\s+(.+)/);
    if (arrayItem && currentKey && Array.isArray(result[currentKey])) {
      let val = arrayItem[1].trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[currentKey].push(val);
      continue;
    }

    // Key: value pair
    const kvMatch = line.match(/^([a-z_]+)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      if (inner.trim() === '') {
        result[key] = [];
      } else {
        result[key] = inner.split(',').map(s => {
          s = s.trim();
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            s = s.slice(1, -1);
          }
          return s;
        });
      }
      currentKey = key;
      continue;
    }

    // Boolean
    if (value === 'true') { result[key] = true; currentKey = key; continue; }
    if (value === 'false') { result[key] = false; currentKey = key; continue; }

    // Quoted string
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
    currentKey = key;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Path resolution — relative to project root, not hardcoded
// ═══════════════════════════════════════════════════════════════
const ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(ROOT, 'rules');
const WS_FILE = path.join(ROOT, 'data', 'workspaces.json');
const WORKSPACE_DIR = path.join(ROOT, 'workspace');
const SETTINGS_FILE = path.join(ROOT, '.claude', 'settings.json');

const BEGIN_MARKER = '<!-- BEGIN ANUKI-RULES (auto-generated, DO NOT EDIT) -->';
const END_MARKER = '<!-- END ANUKI-RULES -->';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--check');
const QUIET = args.includes('--quiet');

function log(...parts) {
  if (!QUIET) console.log(...parts);
}

// ═══════════════════════════════════════════════════════════════
// 1. Rule parsing
// ═══════════════════════════════════════════════════════════════
function parseRules() {
  const files = fs.readdirSync(RULES_DIR)
    .filter(f => f.match(/^\d+-.+\.md$/))
    .sort();

  const rules = [];
  for (const f of files) {
    const full = path.join(RULES_DIR, f);
    const raw = fs.readFileSync(full, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      console.warn(`[WARN] ${f}: no frontmatter, skipping`);
      continue;
    }
    let meta;
    try {
      meta = parseSimpleYaml(fmMatch[1]);
    } catch (e) {
      console.error(`[ERR] ${f}: YAML parse error: ${e.message}`);
      continue;
    }
    const body = fmMatch[2].trim();
    rules.push({
      file: f,
      id: meta.id,
      title: meta.title,
      severity: meta.severity || 'medium',
      applies_to: meta.applies_to || [],
      applies_to_tags: meta.applies_to_tags || [],
      except: meta.except || [],
      enforcement: meta.enforcement || [],
      // PreToolUse hook fields
      trigger_pattern: meta.trigger_pattern || null,
      hook_matcher: meta.hook_matcher || null,
      hook_check: meta.hook_check || null,
      hook_reason: meta.hook_reason || null,
      hook_exempt: meta.hook_exempt || null,
      // Stop hook fields
      stop_hook: meta.stop_hook || false,
      stop_patterns: meta.stop_patterns || [],
      stop_evidence: meta.stop_evidence || [],
      stop_reason: meta.stop_reason || null,
      stop_mode: meta.stop_mode || 'claim',
      body,
    });
  }
  return rules;
}

// ═══════════════════════════════════════════════════════════════
// 2. Agent resolution
// ═══════════════════════════════════════════════════════════════
function loadAgents() {
  if (!fs.existsSync(WS_FILE)) {
    console.warn('[WARN] workspaces.json not found, skipping per-agent rules');
    return [];
  }
  const data = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
  const workspaces = Array.isArray(data) ? data : (data.workspaces || []);
  return workspaces.map(ws => ({
    id: ws.id,
    name: ws.name,
    tags: ws.tags || [],
  }));
}

function rulesForAgent(agent, rules) {
  return rules.filter(rule => {
    if (rule.except.includes(agent.name.toLowerCase()) || rule.except.includes(agent.name)) {
      return false;
    }
    if (rule.applies_to.includes('all')) return true;
    if (rule.applies_to.map(a => a.toLowerCase()).includes(agent.name.toLowerCase())) return true;
    if (rule.applies_to_tags.some(t => agent.tags.includes(t))) return true;
    return false;
  });
}

// ═══════════════════════════════════════════════════════════════
// 3. Content rendering
// ═══════════════════════════════════════════════════════════════
function renderSafetyBlock(agent, rules) {
  const lines = [];
  lines.push(BEGIN_MARKER);
  lines.push('');
  lines.push('# Anuki Core Rules — Enforced');
  lines.push('');
  lines.push(`> Auto-generated from \`rules/\`. Do not edit manually.`);
  lines.push(`> Agent: **${agent.name}**  |  Tags: ${JSON.stringify(agent.tags)}`);
  lines.push(`> Rule count: ${rules.length}`);
  lines.push(`> **To modify rules, edit \`rules/NNN-*.md\` and run \`node scripts/build-rules.js\`.**`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const rule of rules) {
    lines.push(`## ${rule.id}. ${rule.title}`);
    lines.push(`*Severity: ${rule.severity}*`);
    lines.push('');
    lines.push(rule.body);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(END_MARKER);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 4. File update (idempotent marker replacement)
// ═══════════════════════════════════════════════════════════════
function updateFileBlock(filePath, newBlock, fileDescription) {
  let original = '';
  if (fs.existsSync(filePath)) {
    original = fs.readFileSync(filePath, 'utf8');
  }

  const beginIdx = original.indexOf(BEGIN_MARKER);
  const endIdx = original.indexOf(END_MARKER);

  let updated;
  if (beginIdx === -1 || endIdx === -1) {
    updated = (original.trim() ? original.trim() + '\n\n' : '') + newBlock + '\n';
  } else {
    const before = original.substring(0, beginIdx);
    const after = original.substring(endIdx + END_MARKER.length);
    updated = before + newBlock + after;
  }

  updated = updated.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');

  const changed = updated !== original;
  if (!changed) {
    log(`  [skip] ${fileDescription} (no change)`);
    return { changed: false };
  }

  if (DRY_RUN) {
    log(`  [DRY] ${fileDescription} would change (${original.length} -> ${updated.length} bytes)`);
    return { changed: true, dryRun: true };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, updated, 'utf8');
  log(`  [write] ${fileDescription} (${original.length} -> ${updated.length} bytes)`);
  return { changed: true };
}

// ═══════════════════════════════════════════════════════════════
// 5. Hook generation
// ═══════════════════════════════════════════════════════════════

/**
 * Build shell command for a PreToolUse deny rule.
 */
function buildHookCommand(rule) {
  const reason = (rule.hook_reason || `RULE ${rule.id} BLOCK: ${rule.title}`).replace(/"/g, '\\"').replace(/'/g, '');
  const denyJson = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason}"}}`;

  if (!rule.hook_check) return null;

  const parts = rule.hook_check.split(':');
  const checkType = parts[0];
  const checkValue = parts.slice(1).join(':');

  if (checkType === 'file_path_matches') {
    return `fp=$(jq -r '.tool_input.file_path // empty'); if [ -n "$fp" ] && echo "$fp" | grep -qE '${checkValue}'; then echo '${denyJson}'; fi`;
  }

  if (checkType === 'command_matches') {
    const exempt = rule.hook_exempt || '';
    let cmd = `cmd=$(jq -r '.tool_input.command // empty')`;
    if (exempt) {
      cmd += `; is_exempt=$(echo "$cmd" | grep -qE '${exempt}' && echo yes || echo no)`;
      cmd += `; if [ "$is_exempt" = "no" ] && echo "$cmd" | grep -qE '${checkValue}'; then echo '${denyJson}'; fi`;
    } else {
      cmd += `; if echo "$cmd" | grep -qE '${checkValue}'; then echo '${denyJson}'; fi`;
    }
    return cmd;
  }

  if (checkType === 'must_read_before_edit') {
    return `fp=$(jq -r '.tool_input.file_path // empty'); sid=$(jq -r '.session_id // "default"'); sf="/tmp/anuki-read-files-$sid"; if [ -z "$fp" ]; then exit 0; fi; if [ ! -f "$fp" ]; then exit 0; fi; if [ ! -f "$sf" ] || ! grep -qxF "$fp" "$sf" 2>/dev/null; then echo '${denyJson}'; fi`;
  }

  return null;
}

/**
 * Build PostToolUse read tracker command.
 */
function buildReadTrackerCommand() {
  return `fp=$(jq -r '.tool_input.file_path // .tool_input.path // empty'); sid=$(jq -r '.session_id // "default"'); sf="/tmp/anuki-read-files-$sid"; if [ -n "$fp" ]; then echo "$fp" >> "$sf"; sort -u -o "$sf" "$sf"; fi`;
}

/**
 * Build Stop hook command from a rule with stop_hook: true.
 * Scans last_assistant_message for claim patterns without evidence.
 */
/**
 * Sanitize a string for safe use inside shell single-quoted JSON values.
 * Removes characters that could break shell syntax — deadlock prevention.
 */
function sanitizeForShell(s) {
  return s
    .replace(/[\u2018\u2019\u201C\u201D]/g, '') // smart quotes
    .replace(/'/g, '')   // straight single quotes
    .replace(/"/g, '\\"') // escape double quotes
    .replace(/`/g, '')   // backticks
    .replace(/\\/g, ''); // backslashes
}

function buildStopHookCommand(rule) {
  if (!rule.stop_patterns || rule.stop_patterns.length === 0) return null;

  // Escape regex special chars in each pattern for grep -E, then join with |
  const escapeRegex = (s) => s.replace(/[.*+?^${}()\[\]\\]/g, '\\$&');
  const patterns = rule.stop_patterns.map(p => escapeRegex(p)).join('|');
  const reason = sanitizeForShell(rule.stop_reason || `RULE ${rule.id} AUDIT: Response contains unverified claims.`);
  const mode = rule.stop_mode || 'claim'; // 'claim' (default) or 'behavioral'

  // All stop hooks use hook-helper.sh for correct stdin/output schema.
  // Claude Code stop hook stdin does NOT contain last_assistant_message.
  // Must read from transcript_path via get_last_message(). Output must use "approve"/"block" (NOT "allow").
  const helperPreamble = [
    'BASEDIR=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd || echo "$PWD")',
    'source "$BASEDIR/scripts/hook-helper.sh"',
    'hook_stdin',
    'check_hook_active',
  ];

  let cmd;
  if (mode === 'behavioral') {
    // Behavioral mode: pattern found = block. No evidence check.
    cmd = [
      ...helperPreamble,
      'msg=$(get_last_message)',
      'if [ -z "$msg" ]; then exit 0; fi',
      `has_match=$(echo "$msg" | grep -ciE "${patterns}" || true)`,
      'if [ "$has_match" -gt 0 ]; then',
      `  emit_block "${reason}"`,
      'fi',
    ].join('\n');
  } else {
    // Claim mode (default): pattern found + no evidence = block.
    const evidencePattern = '\\.[a-z]{1,4}:[0-9]+|grep.*src/|verified|confirmed|PASS';
    cmd = [
      ...helperPreamble,
      'msg=$(get_last_message)',
      'if [ -z "$msg" ]; then exit 0; fi',
      `has_claim=$(echo "$msg" | grep -ciE "${patterns}" || true)`,
      `has_evidence=$(echo "$msg" | grep -cE "${evidencePattern}" || true)`,
      'if [ "$has_claim" -gt 0 ] && [ "$has_evidence" -eq 0 ]; then',
      `  emit_block "${reason}"`,
      'fi',
    ].join('\n');
  }

  return cmd;
}

/**
 * Generate all hook entries from SSOT rules.
 */
function generateHookEntries(rules) {
  // PreToolUse deny hooks
  const hookRules = rules.filter(r => r.enforcement.includes('pretooluse-deny') && r.hook_matcher && r.hook_check);
  const preToolUse = {};
  let needsReadTracker = false;

  for (const rule of hookRules) {
    const cmd = buildHookCommand(rule);
    if (!cmd) continue;
    const matcher = rule.hook_matcher;
    if (!preToolUse[matcher]) preToolUse[matcher] = [];
    preToolUse[matcher].push({ ruleId: rule.id, command: cmd });
    if (rule.hook_check === 'must_read_before_edit') needsReadTracker = true;
  }

  // Stop hooks
  const stopRules = rules.filter(r => r.stop_hook === true || r.enforcement.includes('stop-hook-audit'));
  const stopHooks = [];
  for (const rule of stopRules) {
    const cmd = buildStopHookCommand(rule);
    if (cmd) stopHooks.push({ ruleId: rule.id, command: cmd });
  }

  return { preToolUse, needsReadTracker, stopHooks };
}

/**
 * Build UserPromptSubmit reminder from all rules.
 */
function buildUserPromptReminder(rules) {
  const safetyRules = rules.filter(r => r.enforcement.includes('soul-safety-inject'));
  if (safetyRules.length === 0) return null;

  const lines = safetyRules.map((r, i) => `${i + 1}. ${r.title} (Rule ${r.id}): ${r.body.split('\\n')[0].substring(0, 120)}`);
  const reminder = `ENFORCED RULES:\\n${lines.join('\\n')}`;
  return `jq -nc '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"${reminder.replace(/"/g, '\\"')}"}}'`;
}

/**
 * Update .claude/settings.json with SSOT-generated hooks.
 * Merges with existing manual hooks, replaces SSOT-generated ones.
 */
function updateSettingsHooks(hookData, rules) {
  let original = '{}';
  let settings = {};

  if (fs.existsSync(SETTINGS_FILE)) {
    original = fs.readFileSync(SETTINGS_FILE, 'utf8');
    try {
      settings = JSON.parse(original);
    } catch (e) {
      console.error(`[ERR] settings.json parse error: ${e.message}`);
      return { changed: false };
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // --- PreToolUse ---
  const existingPre = settings.hooks.PreToolUse || [];
  const manualPre = existingPre.filter(entry => {
    const hooks = entry.hooks || [];
    return !hooks.some(h => h.command && h.command.includes('SSOT_RULE_'));
  });

  const ssotPre = [];
  for (const [matcher, commands] of Object.entries(hookData.preToolUse)) {
    const hookCommands = commands.map(c => ({
      type: 'command',
      command: `# SSOT_RULE_${String(c.ruleId).padStart(3, '0')}\n${c.command}`,
    }));
    ssotPre.push({ matcher, hooks: hookCommands });
  }
  settings.hooks.PreToolUse = [...manualPre, ...ssotPre];

  // --- PostToolUse ---
  const existingPost = settings.hooks.PostToolUse || [];
  const manualPost = existingPost.filter(entry => {
    const hooks = entry.hooks || [];
    return !hooks.some(h => h.command && h.command.includes('SSOT_READ_TRACKER'));
  });

  if (hookData.needsReadTracker) {
    manualPost.push({
      matcher: 'Read|Grep',
      hooks: [{
        type: 'command',
        command: `# SSOT_READ_TRACKER\n${buildReadTrackerCommand()}`,
      }],
    });
  }
  settings.hooks.PostToolUse = manualPost;

  // --- Stop hooks ---
  const existingStop = settings.hooks.Stop || [];
  const manualStop = existingStop.filter(entry => {
    const hooks = entry.hooks || [];
    return !hooks.some(h => h.command && h.command.includes('SSOT_STOP_AUDIT'));
  });

  for (const sh of hookData.stopHooks) {
    manualStop.push({
      hooks: [{
        type: 'command',
        command: `# SSOT_STOP_AUDIT_${String(sh.ruleId).padStart(3, '0')}\n${sh.command}`,
      }],
    });
  }
  settings.hooks.Stop = manualStop;

  // --- UserPromptSubmit ---
  const existingUPS = settings.hooks.UserPromptSubmit || [];
  const manualUPS = existingUPS.filter(entry => {
    const hooks = entry.hooks || [];
    return !hooks.some(h => h.command && h.command.includes('SSOT_PROMPT_REMINDER'));
  });

  const reminderCmd = buildUserPromptReminder(rules);
  if (reminderCmd) {
    manualUPS.push({
      hooks: [{
        type: 'command',
        command: `# SSOT_PROMPT_REMINDER\n${reminderCmd}`,
      }],
    });
  }
  settings.hooks.UserPromptSubmit = manualUPS;

  // --- SessionStart ---
  // Preserve existing SessionStart hooks (memory load, build-rules auto-run)
  // Don't touch them — they're manual

  const updated = JSON.stringify(settings, null, 2) + '\n';
  if (updated === original) {
    log('  [skip] settings.json (no change)');
    return { changed: false };
  }

  if (DRY_RUN) {
    log(`  [DRY] settings.json would change (${original.length} -> ${updated.length} bytes)`);
    return { changed: true, dryRun: true };
  }

  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  // DEADLOCK PROTECTION: Atomic write — write to temp, validate JSON, then rename.
  const tmpSettings = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmpSettings, updated, 'utf8');
  try {
    JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));
  } catch (e) {
    console.error(`  [ERROR] Generated settings.json is invalid JSON — ABORTING: ${e.message}`);
    fs.unlinkSync(tmpSettings);
    return { changed: false };
  }
  fs.renameSync(tmpSettings, SETTINGS_FILE);

  const hookCount = ssotPre.length + hookData.stopHooks.length + (hookData.needsReadTracker ? 1 : 0) + (reminderCmd ? 1 : 0);
  log(`  [write] settings.json (${original.length} -> ${updated.length} bytes) — ${hookCount} SSOT hooks`);
  return { changed: true };
}

// ═══════════════════════════════════════════════════════════════
// 6. Main
// ═══════════════════════════════════════════════════════════════
function main() {
  log(`Anuki Rule Generator ${DRY_RUN ? '(DRY RUN)' : ''}`);
  log(`Project root: ${ROOT}`);
  log(`Rules dir: ${RULES_DIR}`);

  const rules = parseRules();
  log(`Loaded ${rules.length} rules`);

  const agents = loadAgents();
  log(`Loaded ${agents.length} agents`);

  let totalChanged = 0;

  // Per-agent SAFETY.md
  log('\n=== SAFETY.md (per-agent) ===');
  for (const agent of agents) {
    const agentRules = rulesForAgent(agent, rules)
      .filter(r => r.enforcement.includes('soul-safety-inject'));
    const block = renderSafetyBlock(agent, agentRules);
    const safetyPath = path.join(WORKSPACE_DIR, agent.id, 'soul', 'SAFETY.md');
    const result = updateFileBlock(safetyPath, block, `${agent.name} SAFETY.md (${agentRules.length} rules)`);
    if (result.changed) totalChanged++;
  }

  // Hook generation (PreToolUse + PostToolUse + Stop + UserPromptSubmit)
  log('\n=== Hook enforcement (settings.json) ===');
  const hookData = generateHookEntries(rules);
  const r3 = updateSettingsHooks(hookData, rules);
  if (r3.changed) totalChanged++;

  log(`\nTotal files ${DRY_RUN ? 'would change' : 'changed'}: ${totalChanged}`);
  log(`Stop hooks: ${hookData.stopHooks.length}`);
  log(`PreToolUse hooks: ${Object.keys(hookData.preToolUse).length}`);

  if (DRY_RUN && totalChanged > 0) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    console.error(e.stack);
    process.exit(2);
  }
}

module.exports = { main, parseRules, loadAgents, rulesForAgent };
