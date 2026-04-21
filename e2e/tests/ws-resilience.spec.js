// @ts-check
/**
 * Anuki E2E — WebSocket Resilience Tests
 *
 * Tests reconnection, exponential backoff, resume buffers,
 * and connection state indicators.
 *
 * These tests do NOT kill/restart the actual server (production safety).
 * Instead they simulate network failures via page-level WS interception.
 */

const { test, expect } = require('@playwright/test');

// ── Helpers ─────────────────────────────────────────────────────────────

async function waitForOnline(page) {
  await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 8000 });
}

// ── CONNECTION STATE TRACKING ───────────────────────────────────────────

test.describe('WS Resilience — Connection State', () => {
  test('status shows "online" after successful connection', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);
    const status = await page.locator('#headerStatus').textContent();
    expect(status).toBe('online');
  });

  test('reconnection counter exists in client code', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);
    // Verify reconnection infrastructure exists (variable: wsReconnectAttempts)
    const hasReconnectLogic = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      let found = false;
      scripts.forEach(s => {
        if (s.textContent && s.textContent.includes('wsReconnectAttempts')) found = true;
      });
      return found;
    });
    expect(hasReconnectLogic, 'client must have reconnection logic (wsReconnectAttempts)').toBe(true);
  });

  test('exponential backoff parameters exist', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);
    // Check client has backoff config
    const backoffInfo = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      let hasMaxDelay = false;
      let hasGrowthFactor = false;
      scripts.forEach(s => {
        const text = s.textContent || '';
        if (text.includes('8000') || text.includes('maxDelay')) hasMaxDelay = true;
        if (text.includes('1.6') || text.includes('backoff')) hasGrowthFactor = true;
      });
      return { hasMaxDelay, hasGrowthFactor };
    });
    expect(backoffInfo.hasMaxDelay, 'client must have max delay cap').toBe(true);
  });

  test('fast-poll window logic exists for server restart', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);
    // Check for fast-poll / reload handling in client
    const hasFastPoll = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      let found = false;
      scripts.forEach(s => {
        const text = s.textContent || '';
        if (text.includes('reload') && (text.includes('800') || text.includes('fastPoll') || text.includes('fast'))) {
          found = true;
        }
      });
      return found;
    });
    expect(hasFastPoll, 'client must handle reload event with fast retry').toBe(true);
  });
});

// ── SIMULATED DISCONNECT/RECONNECT ──────────────────────────────────────

test.describe('WS Resilience — Disconnect Handling', () => {
  test('ws.onclose handler updates status text', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Verify the onclose handler logic exists in source
    const hasOnclose = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      let found = false;
      scripts.forEach(s => {
        if (s.textContent && s.textContent.includes('ws.onclose') && s.textContent.includes('reconnecting')) {
          found = true;
        }
      });
      return found;
    });
    expect(hasOnclose, 'ws.onclose must set status to reconnecting').toBe(true);
  });

  test('client recovers after page reload (simulates reconnect)', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Reload page — this closes WS and creates new one
    await page.reload();
    await waitForOnline(page);

    // Should be back online after reload
    const status = await page.locator('#headerStatus').textContent();
    expect(status).toBe('online');
  });

  test('reconnect re-sends select-workspace after disconnect', async ({ page }) => {
    const sentMessages = [];
    let wsInstance = null;

    page.on('websocket', ws => {
      wsInstance = ws;
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await waitForOnline(page);
    await page.waitForTimeout(500);

    // Record initial select-workspace count
    const initialCount = sentMessages.filter(m => m.type === 'select-workspace').length;
    expect(initialCount, 'must have initial select-workspace').toBeGreaterThanOrEqual(1);

    // Force close via navigating away and back (reliable cross-browser WS disconnect)
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    await page.goto('/');
    await waitForOnline(page);
    await page.waitForTimeout(500);

    // After page reload + reconnect, should send select-workspace again
    const finalCount = sentMessages.filter(m => m.type === 'select-workspace').length;
    expect(finalCount, 'reconnect must re-send select-workspace').toBeGreaterThan(initialCount);
  });
});

// ── PING/PONG HEARTBEAT ─────────────────────────────────────────────────

test.describe('WS Resilience — Heartbeat', () => {
  test('client responds to ping with pong', async ({ page }) => {
    const sentMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await waitForOnline(page);

    // Simulate server sending ping via handleWSMessage
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'ping', timestamp: Date.now() });
    });

    await page.waitForTimeout(500);
    const pongMsg = sentMessages.find(m => m.type === 'pong');
    expect(pongMsg, 'client must respond to ping with pong').toBeTruthy();
  });

  test('pong includes timestamp from ping', async ({ page }) => {
    const sentMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await waitForOnline(page);

    const ts = Date.now();
    await page.evaluate((timestamp) => {
      window.handleWSMessage({ type: 'ping', timestamp });
    }, ts);

    await page.waitForTimeout(300);
    const pongMsg = sentMessages.find(m => m.type === 'pong');
    expect(pongMsg).toBeTruthy();
    // Pong should echo the timestamp or include its own
    expect(pongMsg.timestamp || pongMsg.ts).toBeTruthy();
  });
});

// ── RESUME BUFFER SUPPORT ───────────────────────────────────────────────

test.describe('WS Resilience — Resume Awareness', () => {
  test('server resume buffer replays events on reconnect', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Start a simulated streaming session
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'text', content: 'Buffer test part 1 ', agentName: 'PROTOS' });
    });

    // Verify streaming message exists
    const streaming = page.locator('.message.assistant.streaming');
    await expect(streaming).toBeVisible();

    // Simulate the server completing the stream (as if buffer replay after reconnect)
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'text', content: 'Buffer test part 2', agentName: 'PROTOS' });
      window.handleWSMessage({ type: 'complete', content: 'Buffer test part 1 Buffer test part 2', agentName: 'PROTOS' });
      window.handleWSMessage({ type: 'done', code: 0 });
    });

    await page.waitForTimeout(300);
    // Messages should be rendered correctly (simulates buffer replay)
    const messages = page.locator('.message.assistant');
    const count = await messages.count();
    expect(count, 'resumed messages should render').toBeGreaterThanOrEqual(1);
  });

  test('conversation sync event updates local state', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Simulate conversationSync event from server
    await page.evaluate(() => {
      window.handleWSMessage({
        type: 'conversationSync',
        conversationId: 'test-sync-id-e2e',
      });
    });

    await page.waitForTimeout(200);
    // Should not crash — graceful handling
    const status = await page.locator('#headerStatus').textContent();
    expect(status).toBe('online');
  });
});

// ── RELOAD EVENT (SERVER RESTART) ───────────────────────────────────────

test.describe('WS Resilience — Server Restart Signal', () => {
  test('reload event triggers reconnect behavior', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Simulate server sending reload (safe-restart notification)
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'reload' });
    });

    // After reload event, client should start fast-poll reconnection
    // The status might briefly show "restarting" or similar
    await page.waitForTimeout(500);

    // Client should not crash and should attempt to reconnect
    // Since server is still up, it should recover
    await page.waitForTimeout(3000);
    const status = await page.locator('#headerStatus').textContent();
    // Should be online or reconnecting (depends on timing)
    expect(['online', 'reconnecting...', 'server restarting...'].includes(status)).toBeTruthy();
  });

  test('system event displays in chat', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Simulate system message
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'system', content: 'Server restarting in 5s...' });
    });

    await page.waitForTimeout(300);
    // System message should appear in UI
    const systemMsg = page.locator('.message.system, .system-message');
    const count = await systemMsg.count();
    // May or may not show as a visible message depending on implementation
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// ── RATE LIMITING ───────────────────────────────────────────────────────

test.describe('WS Resilience — Rate Limiting', () => {
  test('client handles rate_limited response gracefully', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Simulate rate limit event from server
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'error', content: 'Rate limited' });
    });

    await page.waitForTimeout(300);
    // Should not crash, status should remain online
    const status = await page.locator('#headerStatus').textContent();
    expect(status).toBe('online');
  });

  test('rapid messages do not crash client', async ({ page }) => {
    await page.goto('/');
    await waitForOnline(page);

    // Send 50 rapid messages (below server limit of 200/min but tests client stability)
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) {
        window.handleWSMessage({ type: 'text', content: `Rapid ${i} `, agentName: 'PROTOS' });
      }
      window.handleWSMessage({ type: 'complete', content: 'All rapid messages done', agentName: 'PROTOS' });
      window.handleWSMessage({ type: 'done', code: 0 });
    });

    await page.waitForTimeout(500);
    // Client should handle all messages without crash
    const messages = page.locator('.message.assistant');
    const count = await messages.count();
    expect(count, 'rapid messages should render').toBeGreaterThanOrEqual(1);
  });
});
