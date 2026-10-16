import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

const prefix = 'oauth_broker.claude_code_corp_bridge';
const defaults = {
  port: 4093, primary_url: '', standby_url: '', watchdog_status_url: '', secret_mirror_source: '',
};
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'corporate-bridge-schema-'));
  const topPath = join(dir, 'config.yaml');
  try { fn(topPath, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('corporate bridge defaults remain absent', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).get(prefix), defaults);
}));

test('strict corporate deployment keys parse in top and local CFG', () => fixture((topPath, dir) => {
  writeFileSync(topPath, 'version: 1\noauth_broker:\n  claude_code_corp_bridge:\n    port: 4096\n    primary_url: http://host.docker.internal:4096/accounts/claude-code-corp\n');
  writeFileSync(join(dir, 'config.local.yaml'), 'oauth_broker:\n  claude_code_corp_bridge:\n    standby_url: http://127.0.0.1:4096/accounts/claude-code-corp\n    watchdog_status_url: http://127.0.0.1:4096/accounts/claude-code-corp/statusz\n    secret_mirror_source: /private/var/db/synthetic/bearer-secret\n');
  const cfg = loadConfig({ topPath, env: {} });
  assert.deepEqual(cfg.get(prefix), {
    port: 4096,
    primary_url: 'http://host.docker.internal:4096/accounts/claude-code-corp',
    standby_url: 'http://127.0.0.1:4096/accounts/claude-code-corp',
    watchdog_status_url: 'http://127.0.0.1:4096/accounts/claude-code-corp/statusz',
    secret_mirror_source: '/private/var/db/synthetic/bearer-secret',
  });
}));

test('canonical overrides and legacy aliases match Python', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\n');
  const cfg = loadConfig({ topPath, env: {
    AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_PORT: '4094',
    AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_PRIMARY_URL: 'http://host.docker.internal:4094/accounts/claude-code-corp',
    OAUTH_BROKER_WATCHDOG_CLAUDE_CODE_CORP_STATUS_URL: 'http://127.0.0.1:4094/accounts/claude-code-corp/statusz',
    CLAUDE_CODE_CORP_BRIDGE_SECRET_MIRROR_SRC: '/private/var/db/synthetic/bearer-secret',
  } });
  assert.equal(cfg.get(`${prefix}.port`), 4094);
  assert.equal(cfg.get(`${prefix}.primary_url`), 'http://host.docker.internal:4094/accounts/claude-code-corp');
  assert.equal(cfg.get(`${prefix}.watchdog_status_url`), 'http://127.0.0.1:4094/accounts/claude-code-corp/statusz');
  assert.equal(cfg.get(`${prefix}.secret_mirror_source`), '/private/var/db/synthetic/bearer-secret');
}));

for (const body of ['port: 80', 'port: 65536', 'port: nope', 'port: true', 'primary_url: null', 'typo: true']) {
  test(`corporate schema rejects ${body}`, () => fixture((topPath) => {
    writeFileSync(topPath, `version: 1\noauth_broker:\n  claude_code_corp_bridge:\n    ${body}\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
  }));
}
