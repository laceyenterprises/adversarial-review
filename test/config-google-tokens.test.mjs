import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOSConfigError, loadConfig, loadConfigRuntime, validateSchema } from '../src/config-loader.mjs';
import { schemaV1 } from '../src/config-schema.mjs';

const GOOGLE_TOKEN_SCOPES = schemaV1().__keys.services.__keys.hcp.__keys.google_tokens
  .__keys.profiles.__extra_keys_schema.__keys.allowed_scopes.__item.__enum;

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
  ['spaced vault identifier', { document_ref: 'op-document://Lacey Web/Google service account' }],
  ['unknown scope', { allowed_scopes: ['cloud-platform'] }],
  ['malformed task lrq', { task_grants: [{ lrq: 'invalid-lrq', worker_class: 'codex', scopes: ['tagmanager.publish'] }] }],
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


// ONS-07: the Python loader leaves these to HCP's own admission checks; the
// generated validator accepts them too, and a grant without scopes stays
// without scopes (list items are never default-filled).
for (const [name, patch] of [
  ['empty read worker class', { read_worker_classes: [''] }],
  ['wrong project', { project_id: 'other-project' }],
  ['wrong service account domain', { service_account_email: 'automation@other.iam.gserviceaccount.com' }],
  ['grant without scopes', { task_grants: [{ lrq: 'lrq-fixture', worker_class: 'codex' }] }],
]) {
  test(`Google schema accepts ${name} like the Python loader`, () => {
    const doc = { version: 1, services: { hcp: { google_tokens: { profiles: { 'gtm-ga': { ...profile, ...patch } } } } } };
    assert.deepEqual(validateSchema(doc).services.hcp.google_tokens.profiles['gtm-ga'], { ...profile, ...patch });
  });
}

test('partial host metadata remains permitted by the metadata-only mirror', () => {
  const doc = { version: 1, services: { hcp: { google_tokens: { profiles: { fixture: { enabled: true } } } } } };
  const validated = validateSchema(doc);
  assert.equal(validated.services.hcp.google_tokens.profiles.fixture.enabled, true);
  assert.equal(validated.services.hcp.google_tokens.profiles.fixture.document_ref, undefined);
});
