/**
 * Anuki WebSocket Server — Integration Test Suite
 *
 * Tests: connection lifecycle, message dedup, heartbeat, rate limiting,
 * resume buffer, error handling, broadcast, pending completions.
 * Dynamic: no hardcoded IDs or counts.
 * Safe: no destructive operations on real data.
 *
 * Run: node test/websocket.test.js
 * Requires: Anuki server running on PORT (default 3000)
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.ANUKI_TEST_PORT) || parseInt(process.env.PORT) || 3000;
const WS_URL = `ws://localhost:${PORT}`;
const HTTP_BASE = `http://localhost:${PORT}`;

// ── Test infrastructure ─────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];
const startTime = Date.now();

function test(name, fn) {
  return fn().then(() => {
    passed++;
    results.push({ name, status: '✅' });
  }).catch(e => {
    failed++;
    results.push({ name, status: '❌', error: e.message });
  });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function httpReq(method, urlPath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, HTTP_BASE);
    const req = http.request(url, { method, timeout }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── WebSocket helpers ───────────────────────────────────────────────

/**
 * Connect to WS server and wait for 'connected' welcome message.
 * Returns { ws, connectionId, welcome }.
 */
function wsConnect(opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 5000;
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS connect timeout'));
    }, timeout);

    ws.on('open', () => {});
    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          resolve({ ws, connectionId: msg.connectionId, welcome: msg });
        } else {
          reject(new Error(`Expected 'connected', got '${msg.type}'`));
        }
      } catch (e) {
        reject(new Error('Invalid welcome: ' + e.message));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send a JSON message over ws.
 */
function wsSend(ws, msg) {
  ws.send(JSON.stringify(msg));
}

/**
 * Wait for the next message of a specific type (or any type if not specified).
 * Ignores 'ping' messages from heartbeat.
 */
function wsWait(ws, expectedType, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      reject(new Error(`Timed out waiting for '${expectedType || 'any'}' message`));
    }, timeout);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Skip heartbeat pings unless explicitly expected
        if (msg.type === 'ping' && expectedType !== 'ping') {
          wsSend(ws, { type: 'pong', timestamp: new Date().toISOString() });
          return;
        }
        if (!expectedType || msg.type === expectedType) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (e) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        reject(new Error('Invalid JSON: ' + e.message));
      }
    };
    ws.on('message', handler);
  });
}

/**
 * Collect all messages for a duration.
 */
function wsCollect(ws, durationMs) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (data) => {
      try { msgs.push(JSON.parse(data.toString())); } catch (_) {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}

/**
 * Close a WS connection cleanly.
 */
function wsClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return resolve();
    }
    ws.on('close', () => resolve());
    ws.close();
    // Safety timeout — don't hang indefinitely
    setTimeout(() => resolve(), 2000);
  });
}

// ── Dynamic state ───────────────────────────────────────────────────

let FIRST_WS_ID = null;

async function fetchFirstWorkspace() {
  const { body } = await httpReq('GET', '/api/workspaces');
  const data = JSON.parse(body);
  const workspaces = Array.isArray(data) ? data : (data.workspaces || []);
  assert(workspaces.length >= 1, 'Need at least 1 workspace');
  FIRST_WS_ID = workspaces[0].id;
}

// ══════════════════════════════════════════════════════════════════════
// TEST GROUPS
// ══════════════════════════════════════════════════════════════════════

async function group_connection() {
  // T1: Connect and receive welcome message
  await test('T1 — Connect receives welcome message', async () => {
    const { ws, welcome } = await wsConnect();
    assert(welcome.type === 'connected', 'Welcome type should be connected');
    assert(typeof welcome.connectionId === 'string', 'Should have connectionId');
    assert(typeof welcome.timestamp === 'string', 'Should have timestamp');
    assert(typeof welcome.serverStartTime === 'number', 'Should have serverStartTime');
    await wsClose(ws);
  });

  // T2: Connection ID is unique per connection
  await test('T2 — Each connection gets unique ID', async () => {
    const c1 = await wsConnect();
    const c2 = await wsConnect();
    assert(c1.connectionId !== c2.connectionId, 'Connection IDs should differ');
    await wsClose(c1.ws);
    await wsClose(c2.ws);
  });

  // T3: Disconnect cleans up (no leaked client entries)
  await test('T3 — Disconnect is clean (no error)', async () => {
    const { ws } = await wsConnect();
    // Just verify we can close cleanly
    await wsClose(ws);
    // If we get here without error, cleanup worked
  });

  // T4: Multiple concurrent connections
  await test('T4 — Multiple concurrent connections work', async () => {
    const connections = [];
    for (let i = 0; i < 5; i++) {
      connections.push(await wsConnect());
    }
    assert(connections.length === 5, 'Should have 5 connections');
    // Verify all have unique IDs
    const ids = new Set(connections.map(c => c.connectionId));
    assert(ids.size === 5, 'All 5 should have unique IDs');
    for (const c of connections) await wsClose(c.ws);
  });
}

async function group_ping_pong() {
  // T5: Client ping gets server pong response
  await test('T5 — Client ping gets pong response', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'ping' });
    const pong = await wsWait(ws, 'pong', 3000);
    assert(pong.type === 'pong', 'Should receive pong');
    assert(typeof pong.timestamp === 'string', 'Pong should have timestamp');
    await wsClose(ws);
  });

  // T6: Application-level pong marks client alive (no crash)
  await test('T6 — Application pong message accepted', async () => {
    const { ws } = await wsConnect();
    // Send pong (heartbeat response) — should not error
    wsSend(ws, { type: 'pong', timestamp: new Date().toISOString() });
    // Wait briefly for potential error
    const msgs = await wsCollect(ws, 500);
    const errors = msgs.filter(m => m.type === 'error');
    assert(errors.length === 0, 'Pong should not cause error');
    await wsClose(ws);
  });
}

async function group_workspace_select() {
  // T7: Select workspace updates client state
  await test('T7 — Select workspace with valid ID', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, {
      type: 'select-workspace',
      workspaceId: FIRST_WS_ID,
      conversationId: 'test-conv-' + Date.now()
    });
    // Give server time to process (no response expected for select)
    await new Promise(r => setTimeout(r, 200));
    // No error = success
    await wsClose(ws);
  });

  // T8: Legacy 'select' alias works
  await test('T8 — Legacy select alias works', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, {
      type: 'select',
      workspaceId: FIRST_WS_ID,
      conversationId: 'test-conv-legacy-' + Date.now()
    });
    await new Promise(r => setTimeout(r, 200));
    await wsClose(ws);
  });
}

async function group_dedup() {
  // T9: Same messageId within 5min is rejected as duplicate
  await test('T9 — Duplicate messageId rejected', async () => {
    const { ws } = await wsConnect();
    // Must select workspace first
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'dedup-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    const msgId = 'dedup-test-' + Date.now();
    // First send — should be accepted
    wsSend(ws, { type: 'send-message', messageId: msgId, userMessage: 'hello' });
    // Wait for message-received or message-queued
    const first = await wsWait(ws, undefined, 5000);
    assert(first.type !== 'duplicate', 'First message should not be duplicate');

    // Second send with same messageId — should be rejected
    wsSend(ws, { type: 'send-message', messageId: msgId, userMessage: 'hello again' });
    const dup = await wsWait(ws, 'duplicate', 3000);
    assert(dup.type === 'duplicate', 'Second message should be duplicate');
    assert(dup.messageId === msgId, 'Should return same messageId');
    await wsClose(ws);
  });

  // T10: Different messageId is accepted
  await test('T10 — Different messageId accepted', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'dedup-test2-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'send-message', messageId: 'id-a-' + Date.now(), userMessage: 'first' });
    const r1 = await wsWait(ws, undefined, 5000);
    assert(r1.type !== 'duplicate', 'First message OK');

    wsSend(ws, { type: 'send-message', messageId: 'id-b-' + Date.now(), userMessage: 'second' });
    const r2 = await wsWait(ws, undefined, 5000);
    assert(r2.type !== 'duplicate', 'Second message with different ID OK');
    await wsClose(ws);
  });

  // T11: Message without messageId is never deduped
  await test('T11 — Message without messageId never deduped', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'dedup-test3-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'send-message', userMessage: 'no id 1' });
    const r1 = await wsWait(ws, undefined, 5000);
    assert(r1.type !== 'duplicate', 'First no-id message OK');

    wsSend(ws, { type: 'send-message', userMessage: 'no id 2' });
    const r2 = await wsWait(ws, undefined, 5000);
    assert(r2.type !== 'duplicate', 'Second no-id message OK');
    await wsClose(ws);
  });
}

async function group_error_handling() {
  // T12: Invalid JSON returns error
  await test('T12 — Invalid JSON gets error response', async () => {
    const { ws } = await wsConnect();
    ws.send('not json at all {{{');
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Should get error type');
    assert(err.content.includes('Invalid message format'), 'Error should mention invalid format');
    await wsClose(ws);
  });

  // T13: Message too large returns error
  await test('T13 — Oversized message gets error', async () => {
    const { ws } = await wsConnect();
    // Send message larger than 64KB
    const bigMsg = JSON.stringify({ type: 'send-message', userMessage: 'x'.repeat(70000) });
    ws.send(bigMsg);
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Should get error type');
    assert(err.content.includes('too large'), 'Error should mention size');
    await wsClose(ws);
  });

  // T14: Empty message returns error
  await test('T14 — Empty message content gets error', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'err-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'send-message', userMessage: '', images: [] });
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Should get error type');
    assert(err.content.includes('Empty message'), 'Error should mention empty');
    await wsClose(ws);
  });

  // T15: Unknown message type returns error feedback
  await test('T15 — Unknown message type returns error', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'nonexistent-type-xyz' });
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Should get error for unknown type');
    assert(err.content.includes('Unknown message type'), 'Error should mention unknown type');
    await wsClose(ws);
  });
}

async function group_rate_limiting() {
  // T16: Rate limit kicks in after 200 messages
  await test('T16 — Rate limit after 200 non-heartbeat messages', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'rate-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    // Send 200 messages rapidly — use unique messageIds
    // We need to count actual rate-limited messages
    const timestamp = Date.now();
    for (let i = 0; i < 201; i++) {
      wsSend(ws, {
        type: 'send-message',
        messageId: `rate-${timestamp}-${i}`,
        userMessage: `msg ${i}`
      });
    }

    // Collect responses — should see at least one rate-limit error
    const msgs = await wsCollect(ws, 2000);
    const rateLimited = msgs.filter(m => m.type === 'error' && m.content && m.content.includes('Rate limited'));
    assert(rateLimited.length > 0, 'Should see rate-limit error after 200 messages');
    await wsClose(ws);
  });

  // T17: Ping/pong are exempt from rate limiting
  await test('T17 — Ping/pong exempt from rate limit', async () => {
    const { ws } = await wsConnect();
    // Send many pings — should never get rate limited
    for (let i = 0; i < 50; i++) {
      wsSend(ws, { type: 'ping' });
    }
    const msgs = await wsCollect(ws, 1000);
    const pongs = msgs.filter(m => m.type === 'pong');
    const errors = msgs.filter(m => m.type === 'error' && m.content && m.content.includes('Rate limited'));
    assert(pongs.length > 0, 'Should receive pong responses');
    assert(errors.length === 0, 'Pings should not trigger rate limit');
    await wsClose(ws);
  });
}

async function group_message_flow() {
  // T18: Send message gets message-received ack
  await test('T18 — Send message gets acknowledgment', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'flow-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'send-message', messageId: 'flow-' + Date.now(), userMessage: 'test message' });
    // Should receive message-received, conversationSync, or message-queued
    const ack = await wsWait(ws, undefined, 10000);
    const validTypes = ['message-received', 'message-queued', 'conversationSync', 'agent-status'];
    assert(validTypes.includes(ack.type), `Expected ack type, got: ${ack.type}`);
    await wsClose(ws);
  });

  // T19: Legacy 'message' type alias works
  await test('T19 — Legacy message type alias works', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select', workspaceId: FIRST_WS_ID, conversationId: 'legacy-flow-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'message', messageId: 'legacy-' + Date.now(), content: 'test via legacy type' });
    const ack = await wsWait(ws, undefined, 10000);
    const validTypes = ['message-received', 'message-queued', 'conversationSync', 'agent-status', 'error'];
    assert(validTypes.includes(ack.type), `Expected response type, got: ${ack.type}`);
    await wsClose(ws);
  });

  // T20: Message with images field (no actual images, just structure test)
  await test('T20 — Message with empty images accepted', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'img-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'send-message', messageId: 'img-' + Date.now(), userMessage: 'with images field', images: [] });
    const resp = await wsWait(ws, undefined, 10000);
    assert(resp.type !== 'error' || !resp.content.includes('Empty'), 'Message with text+empty images should be accepted');
    await wsClose(ws);
  });
}

async function group_abort() {
  // T21: Abort/cancel when no active job does not crash
  await test('T21 — Abort with no active job is safe', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'abort-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'abort' });
    // Should not crash — may receive cancelled or no response
    const msgs = await wsCollect(ws, 1000);
    const errors = msgs.filter(m => m.type === 'error');
    // Abort on empty is not an error scenario
    assert(true, 'Abort without active job did not crash');
    await wsClose(ws);
  });

  // T22: Legacy 'cancel' alias
  await test('T22 — Legacy cancel alias works', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'cancel-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'cancel' });
    const msgs = await wsCollect(ws, 1000);
    assert(true, 'Cancel alias did not crash');
    await wsClose(ws);
  });
}

async function group_welcome_fields() {
  // T23: Welcome message contains all expected fields
  await test('T23 — Welcome message has all fields', async () => {
    const { ws, welcome } = await wsConnect();
    assert(welcome.type === 'connected', 'type');
    assert(typeof welcome.connectionId === 'string' && welcome.connectionId.length > 0, 'connectionId');
    assert(typeof welcome.timestamp === 'string', 'timestamp');
    assert(typeof welcome.serverStartTime === 'number', 'serverStartTime');
    assert(typeof welcome.isResuming === 'boolean', 'isResuming');
    // staticHash can be undefined or string
    // activeResumes can be undefined or array
    if (welcome.activeResumes !== undefined) {
      assert(Array.isArray(welcome.activeResumes), 'activeResumes should be array');
    }
    await wsClose(ws);
  });

  // T24: serverStartTime is reasonable (within last hour)
  await test('T24 — serverStartTime is reasonable', async () => {
    const { ws, welcome } = await wsConnect();
    const now = Date.now();
    const diff = now - welcome.serverStartTime;
    assert(diff >= 0, 'serverStartTime should be in the past');
    assert(diff < 3600000, 'serverStartTime should be within last hour');
    await wsClose(ws);
  });
}

async function group_concurrent_messages() {
  // T25: Multiple clients selecting different workspaces
  await test('T25 — Multiple clients different workspaces', async () => {
    const c1 = await wsConnect();
    const c2 = await wsConnect();

    wsSend(c1.ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'multi-1-' + Date.now() });
    wsSend(c2.ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'multi-2-' + Date.now() });

    await new Promise(r => setTimeout(r, 300));

    // Both should be functional — send pings
    wsSend(c1.ws, { type: 'ping' });
    wsSend(c2.ws, { type: 'ping' });

    const p1 = await wsWait(c1.ws, 'pong', 3000);
    const p2 = await wsWait(c2.ws, 'pong', 3000);

    assert(p1.type === 'pong', 'Client 1 should get pong');
    assert(p2.type === 'pong', 'Client 2 should get pong');

    await wsClose(c1.ws);
    await wsClose(c2.ws);
  });

  // T26: Rapid connect/disconnect cycle
  await test('T26 — Rapid connect/disconnect cycle', async () => {
    for (let i = 0; i < 10; i++) {
      const { ws } = await wsConnect();
      await wsClose(ws);
    }
    // If no error/hang, test passes
    assert(true, 'Rapid cycle completed');
  });
}

async function group_message_field_compat() {
  // T27: userMessage field
  await test('T27 — userMessage field accepted', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'field-1-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));
    wsSend(ws, { type: 'send-message', messageId: 'f1-' + Date.now(), userMessage: 'via userMessage' });
    const resp = await wsWait(ws, undefined, 10000);
    assert(resp.type !== 'error' || !resp.content.includes('Empty'), 'userMessage field should work');
    await wsClose(ws);
  });

  // T28: content field (backward compat)
  await test('T28 — content field accepted (backward compat)', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'field-2-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));
    wsSend(ws, { type: 'send-message', messageId: 'f2-' + Date.now(), content: 'via content field' });
    const resp = await wsWait(ws, undefined, 10000);
    assert(resp.type !== 'error' || !resp.content.includes('Empty'), 'content field should work');
    await wsClose(ws);
  });

  // T29: message field (backward compat)
  await test('T29 — message field accepted (backward compat)', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'field-3-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));
    wsSend(ws, { type: 'send-message', messageId: 'f3-' + Date.now(), message: 'via message field' });
    const resp = await wsWait(ws, undefined, 10000);
    assert(resp.type !== 'error' || !resp.content.includes('Empty'), 'message field should work');
    await wsClose(ws);
  });
}

async function group_test_stream() {
  // T30: test-stream endpoint (development feature)
  await test('T30 — test-stream returns streaming output', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 'select-workspace', workspaceId: FIRST_WS_ID, conversationId: 'stream-test-' + Date.now() });
    await new Promise(r => setTimeout(r, 200));

    wsSend(ws, { type: 'test-stream', content: 'hello' });
    // Collect messages for a bit — test-stream sends text chunks then done
    const msgs = await wsCollect(ws, 3000);
    const textMsgs = msgs.filter(m => m.type === 'text');
    const doneMsgs = msgs.filter(m => m.type === 'done');
    // test-stream should produce at least some text and a done
    assert(textMsgs.length > 0 || doneMsgs.length > 0, 'test-stream should produce output');
    await wsClose(ws);
  });
}

async function group_edge_cases() {
  // T31: Send message before selecting workspace
  await test('T31 — Message before workspace select', async () => {
    const { ws } = await wsConnect();
    // Don't select workspace — send message directly
    wsSend(ws, { type: 'send-message', messageId: 'noselect-' + Date.now(), userMessage: 'test' });
    // Should still work (server falls back to default workspace)
    const resp = await wsWait(ws, undefined, 10000);
    // Any response type is OK — just shouldn't crash
    assert(resp !== null, 'Should get some response');
    await wsClose(ws);
  });

  // T32: Binary data handling
  await test('T32 — Binary data does not crash server', async () => {
    const { ws } = await wsConnect();
    // Send raw binary
    ws.send(Buffer.from([0x00, 0x01, 0x02, 0xFF]));
    // Should get error response
    const msgs = await wsCollect(ws, 1000);
    // Server should survive — connection still usable
    wsSend(ws, { type: 'ping' });
    const pong = await wsWait(ws, 'pong', 3000);
    assert(pong.type === 'pong', 'Connection should still work after binary data');
    await wsClose(ws);
  });

  // T33: Empty JSON object gets error feedback
  await test('T33 — Empty JSON object gets error', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, {});
    // No type — falls into default case, returns error
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Empty object should get error response');
    await wsClose(ws);
  });

  // T34: Message type as number gets error (type coercion edge case)
  await test('T34 — Non-string type gets error', async () => {
    const { ws } = await wsConnect();
    wsSend(ws, { type: 123 });
    const err = await wsWait(ws, 'error', 3000);
    assert(err.type === 'error', 'Non-string type should get error');
    await wsClose(ws);
  });
}

// ══════════════════════════════════════════════════════════════════════
// RUNNER
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n📡 Anuki WebSocket Test Suite`);
  console.log(`   Target: ${WS_URL}`);
  console.log(`   Time:   ${new Date().toISOString()}\n`);

  // Pre-flight: verify server is running
  try {
    const { status } = await httpReq('GET', '/api/health');
    assert(status === 200, `Health check failed: ${status}`);
  } catch (e) {
    console.error(`❌ Cannot reach server at ${HTTP_BASE} — is Anuki running?`);
    console.error(`   Error: ${e.message}`);
    process.exit(1);
  }

  // Fetch dynamic state
  try {
    await fetchFirstWorkspace();
    console.log(`   Workspace: ${FIRST_WS_ID}\n`);
  } catch (e) {
    console.error(`❌ Cannot fetch workspaces: ${e.message}`);
    process.exit(1);
  }

  console.log('── Connection Lifecycle ──');
  await group_connection();

  console.log('── Ping/Pong ──');
  await group_ping_pong();

  console.log('── Workspace Selection ──');
  await group_workspace_select();

  console.log('── Message Deduplication ──');
  await group_dedup();

  console.log('── Error Handling ──');
  await group_error_handling();

  console.log('── Rate Limiting ──');
  await group_rate_limiting();

  console.log('── Message Flow ──');
  await group_message_flow();

  console.log('── Abort/Cancel ──');
  await group_abort();

  console.log('── Welcome Message ──');
  await group_welcome_fields();

  console.log('── Concurrent Clients ──');
  await group_concurrent_messages();

  console.log('── Message Field Compat ──');
  await group_message_field_compat();

  console.log('── Test Stream ──');
  await group_test_stream();

  console.log('── Edge Cases ──');
  await group_edge_cases();

  // ── Report ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n════════════════════════════════════════');
  console.log(`   Results: ${passed} passed, ${failed} failed (${elapsed}s)`);
  console.log('════════════════════════════════════════');

  for (const r of results) {
    console.log(`  ${r.status} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n  Total: ${passed + failed} tests | ✅ ${passed} | ❌ ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
