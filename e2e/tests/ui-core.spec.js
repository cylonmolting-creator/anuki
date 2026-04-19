// @ts-check
const { test, expect } = require('@playwright/test');

// ═══════════════════════════════════════════════════════
// Anuki E2E — Core UI Tests
// Tests page load, layout, sidebar, header, agents, settings
// ═══════════════════════════════════════════════════════

test.describe('Page Load & Layout', () => {
  test('page loads with correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Anuki/);
  });

  test('app container has sidebar and main area', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.main')).toBeVisible();
  });

  test('sidebar shows Anuki branding and version', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar-header h1')).toHaveText('Anuki');
    await expect(page.locator('.sidebar-header .version')).toHaveText('v0.1');
  });

  test('welcome screen is visible on initial load', async ({ page }) => {
    await page.goto('/');
    // Welcome screen shows — either initial welcome or agent description after selectAgent
    await expect(page.locator('.welcome')).toBeVisible();
    await expect(page.locator('.welcome h2')).not.toHaveText('');
  });

  test('chat header shows default agent name and online status', async ({ page }) => {
    await page.goto('/');
    // Wait for agents to load
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const headerName = page.locator('#headerName');
    // Should show some agent name (dynamic — don't hardcode)
    await expect(headerName).not.toHaveText('');
    await expect(page.locator('#headerStatus')).toHaveText('online');
  });

  test('input area has textarea and send button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#messageInput')).toBeVisible();
    await expect(page.locator('#sendBtn')).toBeVisible();
    await expect(page.locator('#messageInput')).toHaveAttribute('placeholder', 'Type a message...');
  });

  test('typing indicator is hidden by default', async ({ page }) => {
    await page.goto('/');
    const indicator = page.locator('#typingIndicator');
    // Should exist but not be visible (display: none without .active class)
    await expect(indicator).toBeAttached();
    await expect(indicator).not.toHaveClass(/active/);
  });
});

test.describe('Agent List', () => {
  test('loads agents from API dynamically', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const agentItems = page.locator('.agent-item');
    const count = await agentItems.count();
    // Dynamic check — at least 1 agent (Rule 005: no hardcoded counts)
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('each agent has name and role/description', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const agentItems = page.locator('.agent-item');
    const count = await agentItems.count();
    for (let i = 0; i < count; i++) {
      const item = agentItems.nth(i);
      await expect(item.locator('.agent-name')).not.toHaveText('');
      await expect(item.locator('.agent-role')).not.toHaveText('');
    }
  });

  test('each agent has a color dot', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const dots = page.locator('.agent-item .agent-dot');
    const count = await dots.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(dots.nth(i)).toBeVisible();
    }
  });

  test('one agent is active by default', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const activeItems = page.locator('.agent-item.active');
    await expect(activeItems).toHaveCount(1);
  });

  test('clicking different agent changes active state', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const agentItems = page.locator('.agent-item');
    const count = await agentItems.count();
    if (count < 2) {
      test.skip();
      return;
    }
    // Find which one is NOT active
    const firstActive = page.locator('.agent-item.active');
    const firstActiveId = await firstActive.getAttribute('data-agent');

    // Click a different agent
    for (let i = 0; i < count; i++) {
      const item = agentItems.nth(i);
      const id = await item.getAttribute('data-agent');
      if (id !== firstActiveId) {
        await item.click();
        // Now THIS one should be active
        await expect(item).toHaveClass(/active/);
        // The old one should not be active
        const oldItem = page.locator(`.agent-item[data-agent="${firstActiveId}"]`);
        await expect(oldItem).not.toHaveClass(/active/);
        break;
      }
    }
  });

  test('clicking agent updates chat header name and dot color', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const agentItems = page.locator('.agent-item');
    const count = await agentItems.count();
    if (count < 2) {
      test.skip();
      return;
    }

    // Click each agent and verify header updates
    for (let i = 0; i < count; i++) {
      const item = agentItems.nth(i);
      const agentName = await item.locator('.agent-name').textContent();
      await item.click();
      await expect(page.locator('#headerName')).toHaveText(agentName);
    }
  });

  test('clicking agent resets messages to welcome screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const agentItems = page.locator('.agent-item');
    const count = await agentItems.count();
    if (count < 2) {
      test.skip();
      return;
    }

    // Click second agent
    await agentItems.nth(1).click();
    // Welcome should appear with that agent's name
    const welcome = page.locator('.welcome');
    await expect(welcome).toBeVisible();
    const agentName = await agentItems.nth(1).locator('.agent-name').textContent();
    await expect(welcome.locator('h2')).toHaveText(agentName);
  });
});

test.describe('Settings Modal', () => {
  test('settings button exists in sidebar footer', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.settings-btn')).toBeVisible();
    await expect(page.locator('.settings-btn')).toContainText('Settings');
  });

  test('clicking settings opens modal', async ({ page }) => {
    await page.goto('/');
    const modal = page.locator('#settingsModal');
    await expect(modal).not.toHaveClass(/active/);
    await page.locator('.settings-btn').click();
    await expect(modal).toHaveClass(/active/);
  });

  test('settings modal has all form fields', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    await expect(page.locator('#apiKey')).toBeVisible();
    await expect(page.locator('#defaultModel')).toBeVisible();
    await expect(page.locator('#claudePath')).toBeVisible();
  });

  test('settings modal has save and cancel buttons', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    await expect(page.locator('.btn-save')).toBeVisible();
    await expect(page.locator('.btn-cancel')).toBeVisible();
  });

  test('cancel button closes settings modal', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    const modal = page.locator('#settingsModal');
    await expect(modal).toHaveClass(/active/);
    await page.locator('.btn-cancel').click();
    await expect(modal).not.toHaveClass(/active/);
  });

  test('clicking overlay closes settings modal', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    const modal = page.locator('#settingsModal');
    await expect(modal).toHaveClass(/active/);
    // Click on the overlay area (outside the .modal box)
    await modal.click({ position: { x: 10, y: 10 } });
    await expect(modal).not.toHaveClass(/active/);
  });

  test('save button stores API key in localStorage and closes modal', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    await page.locator('#apiKey').fill('test-key-12345');
    await page.locator('.btn-save').click();
    // Modal should close
    await expect(page.locator('#settingsModal')).not.toHaveClass(/active/);
    // localStorage should have the key
    const storedKey = await page.evaluate(() => localStorage.getItem('anuki_api_key'));
    expect(storedKey).toBe('test-key-12345');
  });

  test('model dropdown has valid options', async ({ page }) => {
    await page.goto('/');
    await page.locator('.settings-btn').click();
    const options = page.locator('#defaultModel option');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(1);
    // Each option should have a value
    for (let i = 0; i < count; i++) {
      const val = await options.nth(i).getAttribute('value');
      expect(val).toBeTruthy();
    }
  });
});

test.describe('Message Input', () => {
  test('textarea accepts text input', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#messageInput');
    await input.fill('Hello World');
    await expect(input).toHaveValue('Hello World');
  });

  test('send button triggers message send', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const input = page.locator('#messageInput');
    await input.fill('Test message');

    // Click send
    await page.locator('#sendBtn').click();

    // User message should appear in messages
    const userMsg = page.locator('.message.user');
    await expect(userMsg).toBeVisible();
    await expect(userMsg).toHaveText('Test message');

    // Input should be cleared
    await expect(input).toHaveValue('');

    // Welcome screen should be removed
    await expect(page.locator('.welcome')).toHaveCount(0);
  });

  test('Enter key sends message (without shift)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const input = page.locator('#messageInput');
    await input.fill('Enter key test');
    await input.press('Enter');

    const userMsg = page.locator('.message.user');
    await expect(userMsg).toBeVisible();
    await expect(userMsg).toHaveText('Enter key test');
  });

  test('Shift+Enter does NOT send message (adds newline)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const input = page.locator('#messageInput');
    await input.fill('Line one');
    await input.press('Shift+Enter');
    // Should NOT have sent — no user message in chat
    await expect(page.locator('.message.user')).toHaveCount(0);
  });

  test('empty message is not sent', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const input = page.locator('#messageInput');
    // Leave empty, click send
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.user')).toHaveCount(0);
    // Also try whitespace only
    await input.fill('   ');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.user')).toHaveCount(0);
  });

  test('textarea auto-resizes on long input', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#messageInput');
    const initialHeight = await input.evaluate(el => el.offsetHeight);
    // Type multiple lines
    await input.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    // Trigger oninput by dispatching input event
    await input.dispatchEvent('input');
    const newHeight = await input.evaluate(el => el.offsetHeight);
    expect(newHeight).toBeGreaterThan(initialHeight);
  });

  test('textarea height does not exceed max-height (200px)', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#messageInput');
    // Fill with many lines
    const longText = Array(20).fill('Long line of text here').join('\n');
    await input.fill(longText);
    await input.dispatchEvent('input');
    const height = await input.evaluate(el => el.offsetHeight);
    expect(height).toBeLessThanOrEqual(200);
  });
});

test.describe('WebSocket Connection', () => {
  test('connects and shows online status', async ({ page }) => {
    await page.goto('/');
    // Wait for WebSocket to connect
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });
  });

  test('responds to server ping with pong', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#headerStatus')).toHaveText('online', { timeout: 5000 });

    // Verify WS is connected by checking the status didn't change
    await page.waitForTimeout(1000);
    await expect(page.locator('#headerStatus')).toHaveText('online');
  });
});

test.describe('Message Formatting (XSS & Markdown)', () => {
  test('user messages are plain text (no HTML rendering)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    const input = page.locator('#messageInput');

    // Try XSS payload
    await input.fill('<script>alert("xss")</script>');
    await page.locator('#sendBtn').click();

    const userMsg = page.locator('.message.user');
    await expect(userMsg).toBeVisible();
    // Should be plain text, not rendered HTML
    const innerHTML = await userMsg.innerHTML();
    expect(innerHTML).not.toContain('<script>');
    const textContent = await userMsg.textContent();
    expect(textContent).toContain('<script>');
  });

  test('escapeHtml prevents XSS in assistant messages', async ({ page }) => {
    await page.goto('/');
    // Inject a mock assistant message via JS to test formatting
    const xssPayload = '<img src=x onerror=alert(1)>';
    const result = await page.evaluate((payload) => {
      // Access the escapeHtml function
      return window.escapeHtml ? window.escapeHtml(payload) : 'function not found';
    }, xssPayload);

    // escapeHtml is not on window, but formatContent uses it internally
    // Test via addMessage
    await page.evaluate(() => {
      window.addMessage('assistant', '<img src=x onerror=alert(1)> hello **bold**');
    });
    const assistantMsg = page.locator('.message.assistant').last();
    const html = await assistantMsg.innerHTML();
    // Should NOT have raw <img> tag
    expect(html).not.toContain('<img');
    // Should have escaped version
    expect(html).toContain('&lt;img');
    // Bold should render
    expect(html).toContain('<strong>bold</strong>');
  });

  // An earlier test in this describe block ('user messages are plain text')
  // triggers a real sendBtn.click() which opens a live WS turn. That
  // agent's streaming assistant reply can race into later tests and land
  // as the LAST .message.assistant in the DOM. `.last()` would then
  // target that unrelated message and fail. Use a unique marker in every
  // injected payload and scope assertions to the message containing it.
  test('code blocks render correctly', async ({ page }) => {
    await page.goto('/');
    const marker = 'MK-code-' + Date.now();
    await page.evaluate(
      (m) => window.addMessage('assistant', '```js\nconsole.log("' + m + '");\n```'),
      marker
    );
    const scoped = page.locator('.message.assistant', { hasText: marker });
    const codeBlock = scoped.locator('pre code');
    await expect(codeBlock).toBeVisible();
    const text = await codeBlock.textContent();
    expect(text).toContain(marker);
  });

  test('inline code renders correctly', async ({ page }) => {
    await page.goto('/');
    const marker = 'MK-inline-' + Date.now();
    await page.evaluate(
      (m) => window.addMessage('assistant', m + ' · Use the `npm install` command'),
      marker
    );
    // Collect diagnostic DOM state so any failure has file:line evidence.
    const dump = await page.evaluate((m) => {
      const msgs = Array.from(document.querySelectorAll('.message.assistant'));
      const containing = msgs.filter((el) => (el.textContent || '').includes(m));
      return {
        totalMsgs: msgs.length,
        containing: containing.length,
        lastHtml: msgs.length ? msgs[msgs.length - 1].innerHTML.slice(0, 200) : null,
        containingHtml: containing.length ? containing[0].innerHTML.slice(0, 200) : null,
        welcomePresent: !!document.querySelector('.welcome'),
      };
    }, marker);
    expect(
      dump.containing,
      `marker-scoped message missing; dump=${JSON.stringify(dump)}`
    ).toBeGreaterThanOrEqual(1);
    const scoped = page.locator('.message.assistant', { hasText: marker });
    const inlineCode = scoped.locator('code');
    await expect(inlineCode).toBeVisible();
    await expect(inlineCode).toHaveText('npm install');
  });

  test('bold text renders correctly', async ({ page }) => {
    await page.goto('/');
    const marker = 'MK-bold-' + Date.now();
    await page.evaluate(
      (m) => window.addMessage('assistant', m + ' · This is **important** text'),
      marker
    );
    const scoped = page.locator('.message.assistant', { hasText: marker });
    const bold = scoped.locator('strong');
    await expect(bold).toBeVisible();
    await expect(bold).toHaveText('important');
  });
});

test.describe('Responsive / Mobile', () => {
  test('sidebar hides on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    // Sidebar should be hidden on mobile
    await expect(page.locator('.sidebar')).not.toBeVisible();
  });

  test('hamburger menu appears on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.locator('.mobile-menu-btn')).toBeVisible();
  });

  test('hamburger menu toggles sidebar on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    // Sidebar hidden initially
    await expect(page.locator('.sidebar')).not.toBeVisible();
    // Click hamburger
    await page.locator('.mobile-menu-btn').click();
    // Sidebar should be visible
    await expect(page.locator('.sidebar')).toBeVisible();
    // Click hamburger again to close
    await page.locator('.mobile-menu-btn').click();
    await expect(page.locator('.sidebar')).not.toBeVisible();
  });

  test('mobile sidebar closes when agent is selected', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    // Open sidebar first (agent-items are hidden until sidebar opens on mobile)
    await page.locator('.mobile-menu-btn').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.waitForSelector('.agent-item', { timeout: 5000 });
    // Click an agent
    await page.locator('.agent-item').first().click();
    // Sidebar should close
    await expect(page.locator('.sidebar')).not.toBeVisible();
  });

  test('chat area is full-width on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    const mainWidth = await page.locator('.main').evaluate(el => el.offsetWidth);
    expect(mainWidth).toBeGreaterThanOrEqual(370);
  });
});
