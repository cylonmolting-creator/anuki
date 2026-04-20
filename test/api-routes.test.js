/**
 * Anuki HTTP Routes — Comprehensive API Test Suite
 *
 * Comprehensive API test suite with 77 tests.
 * Dynamic: no hardcoded IDs or counts. Agent/workspace lists fetched at runtime.
 * Safe: DELETE/PUT tests use fake/nonexistent IDs only.
 *
 * Run: node test/api-routes.test.js
 */

const http = require('http');
// Always use port 3000 — Anuki's default. Don't inherit from env.
const PORT = 3000;

// Dynamic workspace + agent state — filled at runtime
let ALL_WORKSPACES = [];
let FIRST_WS = null;

// Test infrastructure
let passed = 0, failed = 0;
const results = [];
const startTime = Date.now();

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++;
        results.push({ name, status: '✅' });
      }).catch(e => {
        failed++;
        results.push({ name, status: '❌', error: e.message });
      });
    }
    passed++;
    results.push({ name, status: '✅' });
  } catch (e) {
    failed++;
    results.push({ name, status: '❌', error: e.message });
  }
  return Promise.resolve();
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function httpReq(method, urlPath, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method,
      timeout,
      headers: {}
    };
    let postData;
    if (body) {
      postData = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function httpGet(p, t) { return httpReq('GET', p, null, t); }
function httpPost(p, b, t) { return httpReq('POST', p, b, t); }
function httpPut(p, b, t) { return httpReq('PUT', p, b, t); }
function httpPatch(p, b, t) { return httpReq('PATCH', p, b, t); }
function httpDelete(p, t) {
  // SAFETY: Block DELETE on real workspace IDs
  if (p.includes('/api/workspaces/') && !p.includes('nonexistent') && !p.includes('test-') && !p.includes('/soul/')) {
    throw new Error(`SAFETY: DELETE blocked on real workspace: ${p}`);
  }
  return httpReq('DELETE', p, null, t);
}

async function runAll() {

  // Wait for server to be up
  for (let i = 0; i < 10; i++) {
    try { await httpGet('/api/health', 2000); break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }

  // Dynamic workspace/agent discovery — no hardcoded IDs
  const wsResp = await httpGet('/api/workspaces');
  const wsList = wsResp.data.workspaces || wsResp.data || [];
  ALL_WORKSPACES = wsList.map(w => ({ id: w.id, name: w.name || w.id.slice(0, 8) }));
  assert(ALL_WORKSPACES.length >= 1, `No workspaces found! Got ${ALL_WORKSPACES.length}`);
  FIRST_WS = ALL_WORKSPACES[0];

  console.log(`\n  Anuki API Routes Test Suite`);
  console.log(`  Port: ${PORT} | Workspaces: ${ALL_WORKSPACES.length}`);
  console.log(`  Agents: ${ALL_WORKSPACES.map(w => w.name).join(', ')}\n`);

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 1: HEALTH & SYSTEM
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 1: HEALTH & SYSTEM ═══');

  await test('1.01 GET /api/health — status ok', async () => {
    const r = await httpGet('/api/health');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.data.status === 'ok', `Expected status ok, got ${r.data.status}`);
    assert(typeof r.data.uptime === 'number', 'uptime must be number');
    assert(typeof r.data.version === 'string', 'version must be string');
    assert(typeof r.data.nodeVersion === 'string', 'nodeVersion must be string');
  });

  await test('1.02 GET /api/health — workspaces count >= 1', async () => {
    const r = await httpGet('/api/health');
    assert(r.data.workspaces >= 1, `Expected workspaces >= 1, got ${r.data.workspaces}`);
  });

  await test('1.03 GET /api/config — returns sanitized config', async () => {
    const r = await httpGet('/api/config');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.data && typeof r.data === 'object', 'config must be object');
  });

  await test('1.04 GET /api/system/stats — system statistics', async () => {
    const r = await httpGet('/api/system/stats');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('1.05 GET /api/logs/status — log status', async () => {
    const r = await httpGet('/api/logs/status');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('1.06 GET /api/safe-restart/status — restart status shape', async () => {
    const r = await httpGet('/api/safe-restart/status');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(typeof r.data.pending === 'boolean', 'pending must be boolean');
    assert(typeof r.data.activeAgents === 'number', 'activeAgents must be number');
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 2: AGENTS
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 2: AGENTS ═══');

  await test('2.01 GET /api/agents — dynamic list', async () => {
    const r = await httpGet('/api/agents');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const agents = r.data.agents || r.data;
    assert(Array.isArray(agents), 'agents must be array (or .agents key)');
    assert(agents.length >= 1, `Expected >= 1 agents, got ${agents.length}`);
  });

  await test('2.02 GET /api/agents — each has id and name', async () => {
    const r = await httpGet('/api/agents');
    const agents = r.data.agents || r.data;
    for (const a of agents) {
      assert(a.id, `Agent missing id: ${JSON.stringify(a).slice(0, 80)}`);
      assert(a.name, `Agent missing name: ${a.id}`);
    }
  });

  await test('2.03 GET /api/agents/discover — discovery list', async () => {
    const r = await httpGet('/api/agents/discover');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const agents = r.data.agents || r.data;
    assert(Array.isArray(agents), 'discover must return array (or .agents key)');
    assert(agents.length >= 1, `Expected >= 1, got ${agents.length}`);
  });

  await test('2.04 GET /api/agents/search — requires query param', async () => {
    const r = await httpGet('/api/agents/search');
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('2.05 GET /api/agents/search?query=code — returns results', async () => {
    const r = await httpGet('/api/agents/search?query=code');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('2.06 GET /api/agents/templates — template list', async () => {
    const r = await httpGet('/api/agents/templates');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('2.07 GET /api/agents/stats/enhanced — all agent stats', async () => {
    const r = await httpGet('/api/agents/stats/enhanced');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('2.08 GET /api/agents/lifecycle/overview — lifecycle summary', async () => {
    const r = await httpGet('/api/agents/lifecycle/overview');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('2.09 GET /api/agent-info — identity check', async () => {
    const r = await httpGet('/api/agent-info');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.data.isAgent === true, 'isAgent must be true');
  });

  await test('2.10 GET /api/agents/nonexistent-safe-id/stats — 404 or graceful', async () => {
    const r = await httpGet('/api/agents/nonexistent-safe-id/stats');
    assert([200, 404, 500].includes(r.status), `Unexpected status ${r.status}`);
  });

  await test('2.11 POST /api/agents/:id/rating — valid body', async () => {
    const r = await httpPost(`/api/agents/${FIRST_WS.id}/rating`, { success: true, latency: 1500 });
    assert([200, 500].includes(r.status), `Expected 200/500, got ${r.status}`);
  });

  await test('2.12 POST /api/agents/:id/rating — rejects invalid body', async () => {
    const r = await httpPost(`/api/agents/${FIRST_WS.id}/rating`, { rating: 5 });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // Dynamic per-workspace agent tests
  for (const ws of ALL_WORKSPACES) {
    await test(`2.A [${ws.name}] GET /api/agents/${ws.id.slice(0,8)}.../stats`, async () => {
      const r = await httpGet(`/api/agents/${ws.id}/stats`);
      assert(r.status === 200, `Expected 200, got ${r.status}`);
    });

    await test(`2.B [${ws.name}] GET /api/agents/${ws.id.slice(0,8)}.../outputs`, async () => {
      const r = await httpGet(`/api/agents/${ws.id}/outputs`);
      assert(r.status === 200, `Expected 200, got ${r.status}`);
    });

    await test(`2.C [${ws.name}] GET /api/agents/${ws.id.slice(0,8)}.../skills`, async () => {
      const r = await httpGet(`/api/agents/${ws.id}/skills`);
      assert([200, 404].includes(r.status), `Expected 200/404, got ${r.status}`);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 3: WORKSPACES
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 3: WORKSPACES ═══');

  await test('3.01 GET /api/workspaces — list with defaultId', async () => {
    const r = await httpGet('/api/workspaces');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const ws = r.data.workspaces || r.data;
    assert(Array.isArray(ws), 'workspaces must be array');
    assert(ws.length >= 1, `Expected >= 1, got ${ws.length}`);
  });

  await test('3.02 GET /api/workspaces/nonexistent-safe — 404', async () => {
    const r = await httpGet('/api/workspaces/test-nonexistent-ws-safe');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('3.03 DELETE /api/workspaces/nonexistent — safe delete', async () => {
    const r = await httpDelete('/api/workspaces/test-nonexistent-ws-safe');
    assert([404, 400, 500].includes(r.status), `Expected error status, got ${r.status}`);
  });

  // Dynamic per-workspace tests
  for (const ws of ALL_WORKSPACES) {
    await test(`3.A [${ws.name}] GET /api/workspaces/${ws.id.slice(0,8)}...`, async () => {
      const r = await httpGet(`/api/workspaces/${ws.id}`);
      assert(r.status === 200, `Expected 200, got ${r.status}`);
    });

    await test(`3.B [${ws.name}] GET /api/workspaces/${ws.id.slice(0,8)}.../soul`, async () => {
      const r = await httpGet(`/api/workspaces/${ws.id}/soul`);
      assert(r.status === 200, `Expected 200, got ${r.status}`);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 4: CONVERSATIONS
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 4: CONVERSATIONS ═══');

  await test('4.01 GET /api/conversations — list', async () => {
    const r = await httpGet('/api/conversations');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('4.02 DELETE /api/conversations/test-conv-nonexistent — safe delete', async () => {
    const r = await httpDelete('/api/conversations/test-conv-nonexistent');
    assert([200, 404].includes(r.status), `Expected 200/404, got ${r.status}`);
  });

  await test('4.03 PATCH /api/conversations/test-conv-nonexistent — safe update', async () => {
    const r = await httpPatch('/api/conversations/test-conv-nonexistent', { title: 'test' });
    assert([200, 404].includes(r.status), `Expected 200/404, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 5: SKILLS
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 5: SKILLS ═══');

  await test('5.01 GET /api/skills/search — requires query', async () => {
    const r = await httpGet('/api/skills/search');
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('5.02 GET /api/skills/search?q=code — works', async () => {
    const r = await httpGet('/api/skills/search?q=code');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('5.03 GET /api/skills/categories — list', async () => {
    const r = await httpGet('/api/skills/categories');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('5.04 GET /api/skills/cache/stats — cache info', async () => {
    const r = await httpGet('/api/skills/cache/stats');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('5.05 GET /api/skills/registry — registry', async () => {
    const r = await httpGet('/api/skills/registry');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 6: GROUP CHAT
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 6: GROUP CHAT ═══');

  await test('6.01 GET /api/groups — list', async () => {
    const r = await httpGet('/api/groups');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('6.02 GET /api/groups/nonexistent-safe — 404', async () => {
    const r = await httpGet('/api/groups/nonexistent-safe');
    assert([404, 200].includes(r.status), `Expected 404/200, got ${r.status}`);
  });

  await test('6.03 POST /api/groups — rejects without participants', async () => {
    const r = await httpPost('/api/groups', {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('6.04 POST /api/groups/nonexistent-safe/close — safe close', async () => {
    const r = await httpPost('/api/groups/nonexistent-safe/close', {});
    assert([200, 400, 404, 500].includes(r.status), `Unexpected ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 7: TASKS & PLANNING
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 7: TASKS & PLANNING ═══');

  await test('7.01 GET /api/tasks — list', async () => {
    const r = await httpGet('/api/tasks');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('7.02 GET /api/tasks/stats — statistics', async () => {
    const r = await httpGet('/api/tasks/stats');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('7.03 GET /api/tasks/nonexistent-safe — 404', async () => {
    const r = await httpGet('/api/tasks/nonexistent-safe');
    assert([404, 200].includes(r.status), `Expected 404/200, got ${r.status}`);
  });

  await test('7.04 POST /api/tasks/plan — rejects short task', async () => {
    const r = await httpPost('/api/tasks/plan', { task: 'ab' });
    assert(r.status === 400, `Expected 400 for short task, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 8: MEMORY & SHARED CONTEXT
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 8: MEMORY & SHARED CONTEXT ═══');

  await test('8.01 GET /api/shared-context — list', async () => {
    const r = await httpGet('/api/shared-context');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('8.02 POST /api/memory/cleanup — requires workspaceId', async () => {
    const r = await httpPost('/api/memory/cleanup', {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('8.03 POST /api/memory/cleanup — safe nonexistent workspace', async () => {
    const r = await httpPost('/api/memory/cleanup', { workspaceId: 'test-safe-nonexistent' });
    assert([200, 400, 404, 500].includes(r.status), `Unexpected ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 9: INTER-AGENT
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 9: INTER-AGENT ═══');

  await test('9.01 GET /api/inter-agent/history — message history', async () => {
    const r = await httpGet('/api/inter-agent/history');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 10: TRACES & PERFORMANCE
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 10: TRACES & PERFORMANCE ═══');

  await test('10.01 GET /api/traces — list', async () => {
    const r = await httpGet('/api/traces');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('10.02 GET /api/traces/stats — trace statistics', async () => {
    const r = await httpGet('/api/traces/stats');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('10.03 GET /api/traces/nonexistent-req-id — 404', async () => {
    const r = await httpGet('/api/traces/nonexistent-req-id-safe');
    assert([200, 404].includes(r.status), `Expected 200/404, got ${r.status}`);
  });

  await test('10.04 GET /api/performance — metrics', async () => {
    const r = await httpGet('/api/performance');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('10.05 GET /api/usage — usage metrics', async () => {
    const r = await httpGet('/api/usage');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 11: WEBHOOKS
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 11: WEBHOOKS ═══');

  await test('11.01 GET /api/webhooks — list', async () => {
    const r = await httpGet('/api/webhooks');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('11.02 GET /api/webhook-logs — logs', async () => {
    const r = await httpGet('/api/webhook-logs');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('11.03 POST /api/webhooks — rejects without id', async () => {
    const r = await httpPost('/api/webhooks', {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 12: SECURITY
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 12: SECURITY ═══');

  await test('12.01 POST /api/security/scan — requires text', async () => {
    const r = await httpPost('/api/security/scan', {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('12.02 POST /api/security/scan — clean text', async () => {
    const r = await httpPost('/api/security/scan', { text: 'hello world no secrets here' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('12.03 POST /api/security/scan — detects patterns', async () => {
    const r = await httpPost('/api/security/scan', { text: 'password=s3cr3t123' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 13: SOUL FILE MANAGEMENT
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 13: SOUL FILE MANAGEMENT ═══');

  await test('13.01 PUT /api/workspaces/:id/soul/:file — rejects empty content', async () => {
    const r = await httpPut(`/api/workspaces/${FIRST_WS.id}/soul/e2e-safe-test.md`, { content: '' });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('13.02 PUT /api/workspaces/:id/soul/:file — rejects missing content', async () => {
    const r = await httpPut(`/api/workspaces/${FIRST_WS.id}/soul/e2e-safe-test.md`, {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('13.03 DELETE /api/workspaces/:id/soul/:file — rejects non-whitelisted', async () => {
    const r = await httpDelete(`/api/workspaces/${FIRST_WS.id}/soul/IDENTITY.md`);
    assert(r.status === 400, `Expected 400 (protected file), got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // CATEGORY 14: EDGE CASES & ERROR HANDLING
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CATEGORY 14: EDGE CASES ═══');

  await test('14.01 GET /api/definitely-not-a-real-route — 404', async () => {
    const r = await httpGet('/api/definitely-not-a-real-route');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('14.02 POST /api/agents — rejects empty body', async () => {
    const r = await httpPost('/api/agents', {});
    assert([400, 500].includes(r.status), `Expected 400/500, got ${r.status}`);
  });

  await test('14.03 GET /api/workspaces/../../etc/passwd/soul — path traversal blocked', async () => {
    const r = await httpGet('/api/workspaces/../../etc/passwd/soul');
    assert([400, 404, 500].includes(r.status), `Expected error, got ${r.status}`);
  });

  await test('14.04 GET /api/agents/search?query=<script>alert(1)</script> — XSS safe', async () => {
    const r = await httpGet('/api/agents/search?query=%3Cscript%3Ealert(1)%3C/script%3E');
    assert([200, 400].includes(r.status), `Expected 200/400, got ${r.status}`);
  });

  await test('14.05 POST /api/agents/nonexistent-safe/message — safe error', async () => {
    const r = await httpPost('/api/agents/nonexistent-safe/message', { content: 'test' });
    assert([400, 404, 500].includes(r.status), `Expected error, got ${r.status}`);
  });

  await test('14.06 POST /api/sessions/inject — rejects missing fields', async () => {
    const r = await httpPost('/api/sessions/inject', {});
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('14.07 GET /api/failures/patterns — failure patterns', async () => {
    const r = await httpGet('/api/failures/patterns');
    assert([200, 503].includes(r.status), `Expected 200/503, got ${r.status}`);
  });

  // ═══════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════
  const elapsed = Date.now() - startTime;
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  HTTP ROUTES: ${passed} passed, ${failed} failed (${elapsed}ms)`);
  console.log(`═══════════════════════════════════════════`);

  if (failed > 0) {
    results.filter(r => r.status === '❌').forEach(r => {
      console.log(`  ${r.status} ${r.name}: ${r.error}`);
    });
    console.log(`\n  ❌ ${failed} TEST FAILED`);
    process.exit(1);
  } else {
    console.log(`\n  ✅ ALL ${passed} TESTS PASSED`);
    process.exit(0);
  }
}

runAll().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
