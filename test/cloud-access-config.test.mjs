import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

test('AFA AWS strict schema is disabled by default and accepts private overlay pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afa-cfg-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    assert.equal(loadConfig({ topPath, env: {} }).get('cloud_access.aws.enabled'), false);
    assert.equal(loadConfig({ topPath, env: {} }).get('cloud_access.aws.region'), 'us-east-2');
    const aws = {
      enabled: true, project_ref: 'fixture-project', budget_topic_arn: '<private-topic>',
      role_arn: '<private-role>', default_profile_arn: '<private-default-profile>',
      trust_anchor_arn: '<private-anchor>', helper_path: '<private-helper>',
      signed_helper_sha256: '<private-pin>', materialization_directory: '<private-materialization>',
      client_ref: '<private-resolver-ref>', host_uri: '<private-host-identity>',
      ca_fingerprint: '<private-ca-pin>',
      budget_name: 'fixture-budget', activation_receipt_path: '<private-receipt>',
      activation_public_key_path: '<private-public-key>',
    };
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ cloud_access: { aws } }));
    for (const loader of [loadConfig, loadConfigRuntime]) {
      for (const [key, value] of Object.entries(aws)) {
        assert.equal(loader({ topPath, env: {} }).get(`cloud_access.aws.${key}`), value);
      }
    }
    rmSync(join(dir, 'config.local.yaml'));
    for (const aws of [{ region: 'us-east-1' }, { enabled: 'true' }, { typo: true }]) {
      writeFileSync(topPath, JSON.stringify({ version: 1, cloud_access: { aws } }));
      assert.throws(() => loadConfig({ topPath, env: {} }), { name: 'AgentOSConfigError' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZFA host overlay parses all foundation leaves with flags disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zfa-cfg-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    const infrastructure = {
      operator_object_id: 'synthetic-owner',
      audit_storage_account_name: 'syntheticarchive',
      default_certificate_path: '<private-default-public-pem>',
      deploy_certificate_path: '<private-deploy-public-pem>',
      budget_email: '<private-recipient>',
      budget_start_date: '2026-10-01T00:00:00Z',
      budget_amount: 20,
      workspace_daily_quota_gb: 1,
      workload_storage_accounts: [{ resource_id: '<reviewed-account>', review_ref: 'D2' }],
    };
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({
      cloud_access: { azure: {
        tenant_id: 'synthetic-tenant', subscription_id: 'synthetic-subscription',
        infrastructure,
      } },
    }));
    for (const loader of [loadConfig, loadConfigRuntime]) {
      const cfg = loader({ topPath, env: {} });
      assert.equal(cfg.get('cloud_access.enabled'), false);
      assert.equal(cfg.get('cloud_access.azure.enabled'), false);
      assert.equal(cfg.get('cloud_access.azure.region'), 'eastus2');
      assert.equal(cfg.get('cloud_access.azure.tenant_id'), 'synthetic-tenant');
      for (const [key, value] of Object.entries(infrastructure)) {
        assert.deepEqual(cfg.get(`cloud_access.azure.infrastructure.${key}`), value);
      }
    }
    for (const [azure, error] of [
      [{ region: 'global' }, {
        name: 'AgentOSConfigError', key: 'cloud_access.azure.region',
        message: /value "global" not in allowlist \["eastus2"\]/,
      }],
      [{ enabled: 'true' }, {
        name: 'AgentOSConfigError', key: 'cloud_access.azure.enabled',
        message: /expected bool, got string/,
      }],
      [{ infrastructure: { budget_amount: -1 } }, {
        name: 'AgentOSConfigError', key: 'cloud_access.azure.infrastructure.budget_amount',
        message: /value -1 below minimum 0\.01/,
      }],
    ]) {
      writeFileSync(topPath, JSON.stringify({ version: 1, cloud_access: { azure } }));
      rmSync(join(dir, 'config.local.yaml'), { force: true });
      assert.throws(() => loadConfig({ topPath, env: {} }), error);
    }
    writeFileSync(topPath, JSON.stringify({ version: 1, cloud_access: { azure: { typo: true } } }));
    assert.throws(() => loadConfig({ topPath, env: {} }), /unknown key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZFA budget_start_date preserves quoted and unquoted YAML timestamps as strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zfa-cfg-date-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const localPath = join(dir, 'config.local.yaml');
    const timestamp = '2026-10-01T00:00:00Z';
    for (const path of [topPath, localPath]) {
      writeFileSync(topPath, 'version: 1\n');
      for (const scalar of [`"${timestamp}"`, `'${timestamp}'`, timestamp]) {
        writeFileSync(path, `${path === topPath ? 'version: 1\n' : ''}cloud_access:
  azure:
    infrastructure:
      budget_start_date: ${scalar}
`);
        for (const loader of [loadConfig, loadConfigRuntime]) {
          assert.equal(loader({ topPath, env: {} })
            .get('cloud_access.azure.infrastructure.budget_start_date'), timestamp);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
