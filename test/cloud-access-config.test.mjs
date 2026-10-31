import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

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
    for (const azure of [{ region: 'global' }, { enabled: 'true' }, { infrastructure: { budget_amount: -1 } }]) {
      writeFileSync(topPath, JSON.stringify({ version: 1, cloud_access: { azure } }));
      rmSync(join(dir, 'config.local.yaml'), { force: true });
      assert.throws(() => loadConfig({ topPath, env: {} }));
    }
    writeFileSync(topPath, JSON.stringify({ version: 1, cloud_access: { azure: { typo: true } } }));
    assert.throws(() => loadConfig({ topPath, env: {} }), /unknown key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
