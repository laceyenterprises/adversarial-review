import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

const defaults = {
  state_dir: '', binary_path: '', custodian_host: '', custodian_user: '',
  known_hosts_file: '', ssh_identity_file: '', enabled: false,
  custodian_principal: 'fleet-ca-custodian', custodian_port: 22,
};
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-schema-'));
  const topPath = join(dir, 'config.yaml');
  try { fn(topPath); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('optional identity defaults preserve disabled network behavior', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\n');
  const cfg = loadConfig({ topPath, env: {} });
  assert.deepEqual(cfg.get('network.identity'), defaults);
  assert.equal(cfg.get('network.cross_node.enabled'), false);
  assert.equal(cfg.get('network.cross_node.auth_mode'), null);
}));
test('identity keys load strictly and environment override uses the canonical name', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\nnetwork:\n  identity:\n    enabled: true\n    custodian_host: ca.test\n    custodian_port: 2222\n');
  const cfg = loadConfig({ topPath, env: { AGENT_OS_NETWORK_IDENTITY_CUSTODIAN_PORT: '2200' } });
  assert.equal(cfg.get('network.identity.enabled'), true);
  assert.equal(cfg.get('network.identity.custodian_host'), 'ca.test');
  assert.equal(cfg.get('network.identity.custodian_port'), 2200);
}));
test('identity ignores unread sibling fields', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\nnetwork:\n  identity:\n    typo: true\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).get('network.identity'), defaults);
}));
for (const body of ['enabled: nope', 'custodian_port: 0', 'custodian_port: 65536']) {
  test(`identity rejects ${body}`, () => fixture((topPath) => {
    writeFileSync(topPath, `version: 1\nnetwork:\n  identity:\n    ${body}\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
  }));
}
test('mirrored existing cross_node accepts legacy disabled and free-form policy', () => fixture((topPath) => {
  writeFileSync(topPath, 'version: 1\nnetwork:\n  cross_node:\n    enabled: false\n    auth_mode: legacy-policy\n    oauth_broker:\n      bind_host: 127.0.0.1\n');
  assert.equal(loadConfig({ topPath, env: {} }).get('network.cross_node.auth_mode'), 'legacy-policy');
}));
