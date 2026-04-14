// @ts-check
const { test, expect } = require('@playwright/test');

// ═══════════════════════════════════════════════════════
// Anuki E2E — WebSocket & Chat Flow Tests
// Tests WS connection, message flow, streaming, reconnection
// ═══════════════════════════════════════════════════════

test.describe('WebSocket Connection Lifecycle', () => {
  test('WebSocket connects automatically on page load', async ({ page }) => {
    await page.goto('/');
    // Wait for WS to connect and status to show 'online'
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });
  });

  test('WebSocket connection state is tracked correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    // ws is a script-scope variable (not window.ws), so verify via status text
    // If status is 'online', WebSocket is connected (readyState = OPEN)
    const statusText = await page.locator('#headerStatus').textContent();
    expect(statusText).toBe('online');
  });

  test('sends select-workspace message on connect', async ({ page }) => {
    // Listen for WebSocket messages
    const wsMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          const data = JSON.parse(frame.payload);
          wsMessages.push(data);
        } catch {}
      });
    });

    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Should have sent a select-workspace message
    const selectMsg = wsMessages.find(m => m.type === 'select-workspace');
    expect(selectMsg).toBeTruthy();
    expect(selectMsg.workspaceId).toBeTruthy();
    expect(selectMsg.conversationId).toBeTruthy();
  });
});

test.describe('Chat Message Flow', () => {
  test('sending message adds user bubble to chat', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    await page.locator('#messageInput').fill('Hello agent');
    await page.locator('#sendBtn').click();

    const userMsg = page.locator('.message.user');
    await expect(userMsg).toHaveCount(1);
    await expect(userMsg).toHaveText('Hello agent');
  });

  test('welcome screen disappears after first message', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Welcome should exist
    await expect(page.locator('.welcome')).toBeVisible();

    // Send a message
    await page.locator('#messageInput').fill('First message');
    await page.locator('#sendBtn').click();

    // Welcome should be gone
    await expect(page.locator('.welcome')).toHaveCount(0);
  });

  test('typing indicator appears after sending message', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    await page.locator('#messageInput').fill('Test typing');
    await page.locator('#sendBtn').click();

    // Typing indicator should appear
    await expect(page.locator('#typingIndicator')).toHaveClass(/active/, { timeout: 3000 });
  });

  test('sending message via WebSocket includes correct fields', async ({ page }) => {
    const sentMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    await page.locator('#messageInput').fill('Test WS message');
    await page.locator('#sendBtn').click();

    // Wait a bit for the WS message
    await page.waitForTimeout(500);

    const chatMsg = sentMessages.find(m => m.type === 'message');
    expect(chatMsg).toBeTruthy();
    expect(chatMsg.content).toBe('Test WS message');
    expect(chatMsg.workspaceId).toBeTruthy();
    expect(chatMsg.conversationId).toBeTruthy();
    expect(chatMsg.channel).toBe('webchat');
  });

  test('multiple messages appear in order', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    // Send 3 messages
    for (const msg of ['First', 'Second', 'Third']) {
      await page.locator('#messageInput').fill(msg);
      await page.locator('#sendBtn').click();
      await page.waitForTimeout(100);
    }

    const userMsgs = page.locator('.message.user');
    await expect(userMsgs).toHaveCount(3);
    await expect(userMsgs.nth(0)).toHaveText('First');
    await expect(userMsgs.nth(1)).toHaveText('Second');
    await expect(userMsgs.nth(2)).toHaveText('Third');
  });
});

test.describe('Simulated Server Messages', () => {
  test('text chunk creates streaming assistant message', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Simulate receiving a text chunk via handleWSMessage
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'text', content: 'Hello from agent', agentName: 'PROTOS' });
    });

    const streaming = page.locator('.message.assistant.streaming');
    await expect(streaming).toBeVisible();
    const text = await streaming.textContent();
    expect(text).toContain('Hello from agent');
  });

  test('complete message finalizes streaming', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Simulate streaming + complete
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'text', content: 'Part 1 ', agentName: 'ENKI' });
      window.handleWSMessage({ type: 'text', content: 'Part 2', agentName: 'ENKI' });
      window.handleWSMessage({ type: 'complete', content: 'Part 1 Part 2 Final', agentName: 'ENKI' });
    });

    // Should have finalized message (no .streaming class)
    const finalMsg = page.locator('.message.assistant:not(.streaming)');
    await expect(finalMsg).toBeVisible();
    const text = await finalMsg.textContent();
    expect(text).toContain('Part 1 Part 2 Final');
  });

  test('done message hides typing indicator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Show typing
    await page.evaluate(() => {
      window.showTyping();
    });
    await expect(page.locator('#typingIndicator')).toHaveClass(/active/);

    // Simulate done
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'done', code: 0 });
    });
    await expect(page.locator('#typingIndicator')).not.toHaveClass(/active/);
  });

  test('error message displays in chat and hides typing', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Show typing first
    await page.evaluate(() => {
      window.showTyping();
    });

    // Simulate error
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'error', content: 'Agent timed out' });
    });

    // Typing should be hidden
    await expect(page.locator('#typingIndicator')).not.toHaveClass(/active/);

    // Error message should appear as system message
    const systemMsg = page.locator('.message.system');
    await expect(systemMsg).toBeVisible();
    const text = await systemMsg.textContent();
    expect(text).toContain('Agent timed out');
  });

  test('cancelled message hides typing indicator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Show typing first, then cancel
    await page.evaluate(() => {
      window.showTyping();
    });
    await expect(page.locator('#typingIndicator')).toHaveClass(/active/);

    await page.evaluate(() => {
      window.handleWSMessage({ type: 'cancelled' });
    });

    // Typing should be hidden after cancel
    await expect(page.locator('#typingIndicator')).not.toHaveClass(/active/);
  });

  test('ping message triggers pong response', async ({ page }) => {
    const sentMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    // Simulate receiving a ping
    await page.evaluate(() => {
      window.handleWSMessage({ type: 'ping', timestamp: Date.now() });
    });

    await page.waitForTimeout(300);
    const pongMsg = sentMessages.find(m => m.type === 'pong');
    expect(pongMsg).toBeTruthy();
  });

  test('agent-label shows in assistant messages', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    await page.evaluate(() => {
      window.addMessage('assistant', 'Test response', 'ENKI');
    });

    const label = page.locator('.message.assistant .agent-label');
    await expect(label).toBeVisible();
    await expect(label).toHaveText('ENKI');
  });
});

test.describe('Agent Switching During Chat', () => {
  test('switching agent clears chat and shows new welcome', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const items = page.locator('.agent-item');
    const count = await items.count();
    if (count < 2) {
      test.skip();
      return;
    }

    // Send a message to first agent
    await page.locator('#messageInput').fill('Hello first agent');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.user')).toHaveCount(1);

    // Switch to second agent
    await items.nth(1).click();

    // Chat should be cleared — no user messages
    await expect(page.locator('.message.user')).toHaveCount(0);
    // Welcome screen should show new agent's name
    await expect(page.locator('.welcome')).toBeVisible();
  });

  test('switching agent sends new select-workspace WS message', async ({ page }) => {
    const sentMessages = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          sentMessages.push(JSON.parse(frame.payload));
        } catch {}
      });
    });

    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    const items = page.locator('.agent-item');
    const count = await items.count();
    if (count < 2) {
      test.skip();
      return;
    }

    // Clear initial messages
    sentMessages.length = 0;

    // Click second agent
    await items.nth(1).click();
    await page.waitForTimeout(300);

    const selectMsg = sentMessages.find(m => m.type === 'select-workspace');
    expect(selectMsg).toBeTruthy();
  });
});

test.describe('Scroll Behavior', () => {
  test('messages auto-scroll to bottom', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });

    // Add many messages to force scroll
    for (let i = 0; i < 20; i++) {
      await page.evaluate((idx) => {
        window.addMessage('assistant', `Message number ${idx} with some extra text to make it longer`, 'PROTOS');
      }, i);
    }

    // Check that scroll position is at (or near) the bottom
    const scrollInfo = await page.evaluate(() => {
      const el = document.getElementById('messages');
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      };
    });

    const isNearBottom = (scrollInfo.scrollTop + scrollInfo.clientHeight) >= (scrollInfo.scrollHeight - 50);
    expect(isNearBottom).toBeTruthy();
  });
});
