import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { deliverAlert, resolveAlertDefaults } from '../src/alert-delivery.mjs';

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
    hooksTokenFile: join(homedir(), '.config', 'adversarial-review', 'secrets', 'litellm-alert-bridge.token'),
    alertChannel: 'telegram',
    alertTo: '123456',
    alertAgentId: 'main',
    alertName: 'Adversarial Watcher Health',
  });
});
