import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { buildReadyzStatus, renderReadyzStatus } from '../src/runtime-readyz.mjs';

function createMockEnvironment(overrides = {}) {
  const rootDir = join(tmpdir(), `readyz-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(rootDir, 'data'), { recursive: true });

  const setup = {
    endpointOk: true,
    routerOk: true,
    smokeOk: true,
    attributionOk: true,
    ...overrides
  };

  if (setup.routerOk) {
    writeFileSync(
      join(rootDir, 'data', 'runtime-status-snapshot.json'),
      JSON.stringify({
        status: {
          probe: { healthy: true },
          wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: true }
        }
      })
    );
  }

  if (setup.smokeOk) {
    writeFileSync(
      join(rootDir, 'data', 'smoke-result.json'),
      JSON.stringify({
        result: 'PASS',
        timestamp: new Date().toISOString()
      })
    );
  } else if (setup.smokeOk === false && overrides.smokeResult) {
    writeFileSync(
      join(rootDir, 'data', 'smoke-result.json'),
      JSON.stringify({
        result: overrides.smokeResult,
        timestamp: new Date().toISOString()
      })
    );
  }

  if (setup.attributionOk !== null) {
    const db = new Database(join(rootDir, 'data', 'reviews.db'));
    db.exec(`
      CREATE TABLE reviewer_passes (
        worker_run_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      )
    `);
    if (setup.attributionOk) {
      db.prepare(
        'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
      ).run('wr_123', 'completed', JSON.stringify({ launchRequestId: 'lrq_123' }));
    } else if (setup.attributionOk === false && overrides.hasPasses) {
      db.prepare(
        'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
      ).run(null, 'completed', JSON.stringify({ launchRequestId: 'lrq_missing' }));
    }
    db.close();
  }

  return rootDir;
}

test('readyz returns allGreen true when all signals pass', async () => {
  const rootDir = createMockEnvironment();
  // Mock fetch to simulate endpoint reachable
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, true);
    
    const rendered = renderReadyzStatus(model);
    assert.ok(rendered.includes('GREEN'));
    assert.ok(rendered.includes('OVERALL: READY'));
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY for an HTTP error response', async () => {
  const rootDir = createMockEnvironment();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    const endpoint = model.signals.find((signal) => signal.id === 'endpoint');
    assert.strictEqual(endpoint.ok, false);
    assert.match(endpoint.detail, /HTTP 503/);
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY if endpoint is unreachable', async () => {
  const rootDir = createMockEnvironment();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('fetch failed'); };

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    
    const rendered = renderReadyzStatus(model);
    assert.ok(rendered.includes('app-contract endpoint'));
    assert.ok(rendered.includes('NOT READY  (fetch failed)'));
    assert.ok(rendered.includes('OVERALL: NOT READY'));
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY if router is unhealthy', async () => {
  const rootDir = createMockEnvironment({ routerOk: false });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    
    const rendered = renderReadyzStatus(model);
    assert.ok(rendered.includes('router health / failover wired'));
    assert.ok(rendered.includes('NOT READY  (snapshot missing)'));
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY if dispatch_status wiring is absent', async () => {
  const rootDir = createMockEnvironment();
  writeFileSync(
    join(rootDir, 'data', 'runtime-status-snapshot.json'),
    JSON.stringify({
      status: {
        probe: { healthy: true },
        wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: false }
      }
    })
  );
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    const router = model.signals.find((signal) => signal.id === 'router');
    assert.strictEqual(router.detail, 'classification/healthz/dispatch_status null');
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY if smoke result is not PASS', async () => {
  const rootDir = createMockEnvironment({ smokeOk: false, smokeResult: 'FAIL' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    
    const rendered = renderReadyzStatus(model);
    assert.ok(rendered.includes('settle smoke (agent-runtime)'));
    assert.ok(rendered.includes('NOT READY  (last result was FAIL)'));
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY if attribution is missing', async () => {
  const rootDir = createMockEnvironment({ attributionOk: false, hasPasses: true });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    
    const rendered = renderReadyzStatus(model);
    assert.ok(rendered.includes('attribution round-trip'));
    assert.ok(rendered.includes('NOT READY  (last 1 SDK passes: 0 attributed)'));
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz ignores active and cli-direct passes in attribution readiness', async () => {
  const rootDir = createMockEnvironment();
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.prepare(
    'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
  ).run(null, 'running', JSON.stringify({ launchRequestId: 'lrq_in_flight' }));
  db.prepare(
    'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
  ).run(null, 'completed', '{}');
  db.close();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, true);
    const attribution = model.signals.find((signal) => signal.id === 'attribution');
    assert.strictEqual(attribution.detail, 'last 1 SDK passes: 1 attributed');
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz rejects a PASS smoke artifact without a timestamp', async () => {
  const rootDir = createMockEnvironment();
  writeFileSync(join(rootDir, 'data', 'smoke-result.json'), JSON.stringify({ result: 'PASS' }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });

  try {
    const model = await buildReadyzStatus(rootDir);
    assert.strictEqual(model.overallReady, false);
    const smoke = model.signals.find((signal) => signal.id === 'smoke');
    assert.strictEqual(smoke.detail, 'PASS timestamp missing or invalid');
  } finally {
    global.fetch = originalFetch;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
