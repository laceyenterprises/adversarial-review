import test from 'node:test';
import assert from 'node:assert/strict';
<<<<<<< HEAD
import http from 'node:http';

import {
  deliverAlert,
  httpRequestText,
  readHooksToken,
  resolveAlertDefaults,
} from '../src/alert-delivery.mjs';
=======

import { deliverAlert, resolveAlertDefaults } from '../src/alert-delivery.mjs';
>>>>>>> b212f532fbee5d5c635e9057b097e32b3c96d39b

test('watcher alert delivery uses the litellm drift-watch ALERT env shape', async () => {
  const calls = [];
  const env = {
    OPENCLAW_AGENT_HOOKS_URL: 'http://127.0.0.1:18789/hooks/agent',
    OPENCLAW_HOOKS_TOKEN_FILE: '/secrets/hooks.token',
    ALERT_TO: '123456',
    ALERT_AGENT_ID: 'ops',
    ALERT_NAME: 'Adversarial Watcher Health Test',
    ALERT_CHANNEL: 'telegram',
  };

  await deliverAlert('watcher.no_progress text', {
    event: 'watcher.no_progress',
    payload: { openPendingPRs: 2 },
    env,
    fsImpl: {
<<<<<<< HEAD
      statSync(filePath) {
        assert.equal(filePath, '/secrets/hooks.token');
        return { mtimeMs: 1 };
      },
=======
>>>>>>> b212f532fbee5d5c635e9057b097e32b3c96d39b
      readFileSync(filePath, encoding) {
        assert.equal(filePath, '/secrets/hooks.token');
        assert.equal(encoding, 'utf8');
        return 'hook-token';
      },
    },
    requestText: async (url, options) => {
      calls.push({ url, options });
      return 'ok';
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18789/hooks/agent');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, {
    Authorization: 'Bearer hook-token',
  });
  assert.deepEqual(calls[0].options.body, {
    message: 'watcher.no_progress text',
    name: 'Adversarial Watcher Health Test',
    agentId: 'ops',
    wakeMode: 'now',
    deliver: true,
    channel: 'telegram',
    to: '123456',
    event: 'watcher.no_progress',
    payload: { openPendingPRs: 2 },
  });
});

test('watcher alert defaults require an explicit recipient', () => {
  assert.throws(
    () => resolveAlertDefaults({}),
    /ALERT_TO must be configured for alert delivery/
  );
});

test('watcher alert defaults use the operator Telegram route once ALERT_TO is configured', () => {
  assert.deepEqual(resolveAlertDefaults({ ALERT_TO: '123456' }), {
    openclawAgentHooksUrl: 'http://127.0.0.1:18789/hooks/agent',
    hooksTokenFile: '/Users/airlock/agent-os/agents/clio/credentials/local/litellm-alert-bridge.token',
    alertChannel: 'telegram',
    alertTo: '123456',
    alertAgentId: 'main',
    alertName: 'Adversarial Watcher Health',
  });
});
<<<<<<< HEAD

test('readHooksToken throws when no env token or token file is available', () => {
  assert.throws(
    () => readHooksToken({
      env: { ALERT_TO: '123456' },
      fsImpl: {
        statSync() {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        },
        readFileSync() {
          throw new Error('should not read without stat');
        },
      },
      logger: { warn() {} },
    }),
    /Missing OpenClaw hooks token/
  );
});

test('readHooksToken logs non-ENOENT token file failures', () => {
  const warnings = [];
  assert.throws(
    () => readHooksToken({
      env: { ALERT_TO: '123456' },
      fsImpl: {
        statSync() {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        },
        readFileSync() {
          throw new Error('should not read without stat');
        },
      },
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    }),
    /Missing OpenClaw hooks token/
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to read hooks token file/);
});

test('httpRequestText rejects with response body details on server errors', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('gateway unavailable');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await assert.rejects(
    () => httpRequestText(`http://127.0.0.1:${port}/hooks`, { timeoutMs: 250 }),
    /HTTP 500: gateway unavailable/
  );

  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test('httpRequestText rejects on timeout and destroys the request', async () => {
  const server = http.createServer(() => {
    // Intentionally never respond so the client timeout path fires.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await assert.rejects(
    () => httpRequestText(`http://127.0.0.1:${port}/hooks`, { timeoutMs: 25 }),
    /timed out after 25ms/
  );

  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});
=======
>>>>>>> b212f532fbee5d5c635e9057b097e32b3c96d39b
