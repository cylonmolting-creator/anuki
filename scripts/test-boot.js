#!/usr/bin/env node
/**
 * test-boot.js — Runtime boot verification for Anuki
 *
 * This is the real `npm test`. It:
 *   1. Spawns `node src/index.js` as a child process
 *   2. Waits up to 15 seconds for boot
 *   3. Polls http://localhost:3000/api/health until HTTP 200 + status:"ok"
 *   4. Kills the child and exits 0 on success, 1 on failure
 *
 * This catches errors that syntax checks miss:
 *   - Missing modules (e.g. the memory/cognitive issue that shipped broken)
 *   - TDZ / ReferenceError at module load time
 *   - Config file parse errors
 *   - Port conflicts
 *
 * Use it before every commit. `npm test` is now meaningful again.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;
const HEALTH_URL = `http://localhost:${PORT}/api/health`;
const BOOT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body, parseError: e.message });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function waitForHealthy(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await httpGetJson(HEALTH_URL);
      if (res.status === 200 && res.body && res.body.status === 'ok') {
        return res.body;
      }
    } catch (e) {
      // connection refused, not booted yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('boot timeout — server did not become healthy');
}

async function main() {
  console.log('[test-boot] Starting Anuki...');
  const child = spawn('node', ['src/index.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });

  const logs = [];
  child.stdout.on('data', (d) => { logs.push(d.toString()); });
  child.stderr.on('data', (d) => { logs.push(d.toString()); });

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  try {
    // Detect early crash
    await new Promise((r) => setTimeout(r, 500));
    if (exited) {
      console.error(`[test-boot] FAIL — server exited early (code=${exitCode})`);
      console.error('--- last log output ---');
      console.error(logs.join('').slice(-2000));
      process.exit(1);
    }

    const health = await waitForHealthy(deadline);
    console.log('[test-boot] PASS');
    console.log(`  status=${health.status}, version=${health.version}, workspaces=${health.workspaces}, provider=${health.provider}`);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  } catch (e) {
    console.error(`[test-boot] FAIL — ${e.message}`);
    console.error('--- last log output ---');
    console.error(logs.join('').slice(-2000));
    if (!exited) child.kill('SIGKILL');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[test-boot] FATAL — ${e.message}`);
  process.exit(2);
});
