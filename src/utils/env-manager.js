const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_PATH = path.join(require('./base-dir'), '.env');

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const vars = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let val = trimmed.substring(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function setEnvVars(vars) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  }

  const updated = new Set();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    if (key in vars) {
      lines[i] = `${key}=${vars[key]}`;
      updated.add(key);
    }
  }

  for (const [key, val] of Object.entries(vars)) {
    if (!updated.has(key)) {
      lines.push(`${key}=${val}`);
    }
    process.env[key] = val;
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

function removeEnvVars(keys) {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const keysSet = new Set(keys);

  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return true;
    const key = trimmed.substring(0, eqIdx).trim();
    return !keysSet.has(key);
  });

  fs.writeFileSync(ENV_PATH, filtered.join('\n'));

  for (const key of keys) {
    delete process.env[key];
  }
}

module.exports = { readEnvFile, setEnvVars, removeEnvVars };
