import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOSConfigError, loadConfig, loadConfigRuntime, validateSchema } from '../src/config-loader.mjs';
import { GOOGLE_TOKEN_SCOPES } from '../src/config-google-tokens.mjs';

const profile = {
  enabled: true,
  document_ref: 'op-document://Fixture/Google service account',
  service_account_email: 'automation@lacey-web.iam.gserviceaccount.com',
  project_id: 'lacey-web',
  allowed_scopes: GOOGLE_TOKEN_SCOPES,
  read_worker_classes: [],
  task_grants: [{ lrq: 'lrq-fixture', worker_class: 'codex', scopes: ['tagmanager.publish'] }],
};

test('Google profile metadata accepted by all strict Node entrypoints with no ambient grants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-schema-'));
  const topPath = join(dir, 'config.yaml');
  try {
    writeFileSync(topPath, 'version: 1\n');
    assert.deepEqual(loadConfig({ topPath, env: {} }).get('services.hcp.google_tokens.profiles') ?? {}, {});
    const doc = { version: 1, services: { hcp: { google_tokens: { profiles: { 'gtm-ga': profile } } } } };
    writeFileSync(topPath, JSON.stringify(doc));
    validateSchema(doc);
    for (const load of [loadConfig, loadConfigRuntime]) {
      assert.deepEqual(load({ topPath, env: {} }).get('services.hcp.google_tokens.profiles.gtm-ga'), profile);
      writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({
        services: { hcp: { google_tokens: { profiles: { 'gtm-ga': { task_grants: [] } } } } },
      }));
      assert.deepEqual(load({ topPath, env: {} }).get('services.hcp.google_tokens.profiles.gtm-ga.task_grants'), []);
      rmSync(join(dir, 'config.local.yaml'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, patch] of [
  ['unknown scope', { allowed_scopes: ['cloud-platform'] }],
  ['wrong project', { project_id: 'other-project' }],
  ['field reference', { document_ref: 'op://Fixture/item/credential' }],
  ['path injection', { document_ref: 'op-document://Fixture/item/field' }],
  ['secret field', { private_key: 'forbidden' }],
  ['unknown grant scope', { task_grants: [{ lrq: 'lrq-fixture', worker_class: 'codex', scopes: ['analytics.manage.users'] }] }],
]) {
  test(`Google schema refuses ${name}`, () => {
    const doc = { version: 1, services: { hcp: { google_tokens: { profiles: { 'gtm-ga': { ...profile, ...patch } } } } } };
    assert.throws(() => validateSchema(doc), AgentOSConfigError);
  });
}
