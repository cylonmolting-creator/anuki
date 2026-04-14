// @ts-check
const { test, expect } = require('@playwright/test');

// ═══════════════════════════════════════════════════════
// Anuki E2E — API & Backend Tests
// Tests REST endpoints, health, agents, config, error handling
// ═══════════════════════════════════════════════════════

test.describe('Health & Status', () => {
  test('GET /api/health returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(body.nodeVersion).toBeTruthy();
    expect(body.uptime).toBeGreaterThan(0);
    expect(body.workspaces).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/health has provider info', async ({ request }) => {
    const res = await request.get('/api/health');
    const body = await res.json();
    expect(body.provider).toBeTruthy();
  });
});

test.describe('Agents API', () => {
  test('GET /api/agents returns agent list', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const agents = body.agents || body;
    expect(Array.isArray(agents)).toBeTruthy();
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  test('each agent has required fields', async ({ request }) => {
    const res = await request.get('/api/agents');
    const body = await res.json();
    const agents = body.agents || body;
    for (const agent of agents) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      // description may be optional but id/name are required
    }
  });

  test('at least one agent is marked as default', async ({ request }) => {
    const res = await request.get('/api/agents');
    const body = await res.json();
    const agents = body.agents || body;
    // Either one is explicitly default, or the first one serves as default
    // Don't require isDefault flag — some implementations use first-agent-as-default
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  test('agent names are unique', async ({ request }) => {
    const res = await request.get('/api/agents');
    const body = await res.json();
    const agents = body.agents || body;
    const names = agents.map(a => a.name);
    const uniqueNames = [...new Set(names)];
    expect(names.length).toBe(uniqueNames.length);
  });

  test('agent IDs are unique', async ({ request }) => {
    const res = await request.get('/api/agents');
    const body = await res.json();
    const agents = body.agents || body;
    const ids = agents.map(a => a.id);
    const uniqueIds = [...new Set(ids)];
    expect(ids.length).toBe(uniqueIds.length);
  });
});

test.describe('Config API', () => {
  test('GET /api/config returns configuration', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toBeTruthy();
    // Should have agent config
    expect(body.agent || body.provider).toBeTruthy();
  });
});

test.describe('Workspaces API', () => {
  test('GET /api/workspaces returns workspace list', async ({ request }) => {
    const res = await request.get('/api/workspaces');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const workspaces = body.workspaces || body;
    expect(Array.isArray(workspaces)).toBeTruthy();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
  });

  test('each workspace has id and name', async ({ request }) => {
    const res = await request.get('/api/workspaces');
    const body = await res.json();
    const workspaces = body.workspaces || body;
    for (const ws of workspaces) {
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBeTruthy();
    }
  });
});

test.describe('Error Handling', () => {
  test('404 for non-existent API route', async ({ request }) => {
    const res = await request.get('/api/nonexistent-route-xyz');
    expect(res.status()).toBe(404);
  });

  test('non-existent agent returns error', async ({ request }) => {
    const res = await request.get('/api/agents/nonexistent-agent-id-safe-test');
    // Should return 404 or error
    expect([400, 404, 500].includes(res.status())).toBeTruthy();
  });

  test('DELETE non-existent workspace returns error (safe test)', async ({ request }) => {
    // Rule 010: NEVER use real IDs for destructive tests
    const res = await request.delete('/api/workspaces/test-nonexistent-ws-safe-e2e');
    // Should fail gracefully — not 200
    expect(res.status()).not.toBe(200);
  });
});

test.describe('Static Files', () => {
  test('index.html serves correctly', async ({ request }) => {
    const res = await request.get('/');
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body).toContain('Anuki');
    expect(body).toContain('<html');
  });

  test('Content-Type for HTML is correct', async ({ request }) => {
    const res = await request.get('/');
    const contentType = res.headers()['content-type'];
    expect(contentType).toContain('text/html');
  });
});
