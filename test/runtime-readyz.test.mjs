import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { writeSettleSmokeResult } from '../src/adapters/agent-runtime/settle-smoke.mjs';
import { buildReadyzStatus, renderReadyzStatus } from '../src/runtime-readyz.mjs';

function registeredAppRegistrationOptions() {
  return {
    appRegistrationOptions: {
      loadConfigImpl: () => ({
        get(key, defaultValue = null) {
          const values = {
            'apps.adversarial-review': {
              mode: 'agent-os',
              subscribes: ['health.worker.*', 'token.*', 'system.*'],
              contract_version: '1.0',
            },
          };
          return key in values ? values[key] : defaultValue;
        },
        sources: {
          'apps.adversarial-review.mode': 'top',
        },
      }),
    },
  };
}

function makeRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'readyz-test-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  return rootDir;
}

function createPassDb(rootDir, { endedAt = null, workerRunId = 'wr_123' } = {}) {
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  if (endedAt === null) {
    db.exec(`
      CREATE TABLE reviewer_passes (
        worker_run_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
    ).run(workerRunId, 'completed', JSON.stringify({ launchRequestId: 'lrq_123' }));
  } else {
    db.exec(`
      CREATE TABLE reviewer_passes (
        worker_run_id TEXT,
        status TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, ended_at, metadata_json) VALUES (?, ?, ?, ?)'
    ).run(workerRunId, 'completed', endedAt, JSON.stringify({ launchRequestId: 'lrq_123' }));
  }
  db.close();
}

function seedHealthyRuntime(rootDir, now = '2026-08-04T10:00:00.000Z') {
  writeFileSync(
    join(rootDir, 'data', 'runtime-status-snapshot.json'),
    JSON.stringify({
      status: {
        probe: { healthy: true },
        wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: true },
      },
    }),
  );
  writeSettleSmokeResult(rootDir, 'agent-runtime', {
    status: 'pass',
    at: now,
    dispatched: true,
    settled: true,
    attributed: true,
    workerRunId: 'wr_smoke',
  });
  createPassDb(rootDir);
}

function withFetch(bodyOrFn) {
  const originalFetch = global.fetch;
  global.fetch = async (requestUrl) => {
    if (typeof bodyOrFn === 'function') return bodyOrFn(requestUrl);
    return {
      ok: true,
      status: 200,
      async json() {
        return bodyOrFn;
      },
    };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

function healthyEndpointPayload() {
  return {
    ok: true,
    supervisor: {
      duplicate_detected: false,
      stale_bind_detected: false,
    },
  };
}

test('readyz is green only when every signal passes', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, {
      ...registeredAppRegistrationOptions(),
      now: () => new Date('2026-08-04T10:04:00.000Z'),
    });
    assert.equal(model.overallReady, true);
    assert.deepEqual(model.failingSignals, []);
    assert.deepEqual(model.app_registration, {
      app_id: 'adversarial-review',
      mode: 'agent-os',
      subscribes: ['health.worker.*', 'token.*', 'system.*'],
      contract_version: '1.0',
      registered: true,
      source: 'apps-registry',
    });
    assert.match(renderReadyzStatus(model), /OVERALL: READY/);
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz endpoint signal fails closed on duplicate instance supervisor state', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch({
    ok: true,
    supervisor: {
      duplicate_detected: true,
      stale_bind_detected: false,
    },
  });
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['endpoint']);
    const endpoint = model.signals.find((signal) => signal.id === 'endpoint');
    assert.equal(endpoint.detail, 'supervisor duplicate_detected=true');
    assert.match(renderReadyzStatus(model), /failing: endpoint/);
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz endpoint signal fails closed on stale bind supervisor state', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch({
    ok: true,
    supervisor: {
      duplicate_detected: false,
      stale_bind_detected: true,
    },
  });
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['endpoint']);
    const endpoint = model.signals.find((signal) => signal.id === 'endpoint');
    assert.equal(endpoint.detail, 'supervisor stale_bind_detected=true');
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz preserves endpoint base paths when probing healthz', async () => {
  const rootDir = makeRoot();
  const requestedUrls = [];
  const restoreFetch = withFetch(async (requestUrl) => {
    requestedUrls.push(String(requestUrl));
    return {
      ok: true,
      status: 200,
      async json() {
        return healthyEndpointPayload();
      },
    };
  });
  const originalUrl = process.env.APP_CONTRACT_ENDPOINT_URL;
  process.env.APP_CONTRACT_ENDPOINT_URL = 'http://127.0.0.1:8003/agent-1';
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, true);
    assert.deepEqual(requestedUrls, ['http://127.0.0.1:8003/agent-1/healthz']);
  } finally {
    restoreFetch();
    if (originalUrl === undefined) {
      delete process.env.APP_CONTRACT_ENDPOINT_URL;
    } else {
      process.env.APP_CONTRACT_ENDPOINT_URL = originalUrl;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY for endpoint HTTP errors and fetch failures', async () => {
  const rootDir = makeRoot();
  seedHealthyRuntime(rootDir);

  let httpErrorBodyCancelled = false;
  let restoreFetch = withFetch(async () => ({
    ok: false,
    status: 503,
    body: {
      async cancel() {
        httpErrorBodyCancelled = true;
      },
    },
  }));
  try {
    const httpModel = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(httpModel.overallReady, false);
    assert.deepEqual(httpModel.failingSignals, ['endpoint']);
    assert.equal(httpModel.signals.find((signal) => signal.id === 'endpoint').detail, 'HTTP 503');
    assert.equal(httpErrorBodyCancelled, true);
  } finally {
    restoreFetch();
  }

  restoreFetch = withFetch(async () => { throw new Error('fetch failed'); });
  try {
    const fetchModel = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(fetchModel.overallReady, false);
    assert.deepEqual(fetchModel.failingSignals, ['endpoint']);
    assert.match(renderReadyzStatus(fetchModel), /NOT READY  \(fetch failed\)/);
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz returns NOT READY instead of throwing when APP_CONTRACT_ENDPOINT_URL is invalid', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  const originalUrl = process.env.APP_CONTRACT_ENDPOINT_URL;
  process.env.APP_CONTRACT_ENDPOINT_URL = '127.0.0.1:8003';
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['endpoint']);
    assert.match(
      model.signals.find((signal) => signal.id === 'endpoint').detail,
      /Invalid URL/,
    );
  } finally {
    restoreFetch();
    if (originalUrl === undefined) {
      delete process.env.APP_CONTRACT_ENDPOINT_URL;
    } else {
      process.env.APP_CONTRACT_ENDPOINT_URL = originalUrl;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz router signal fails when snapshot is missing or dispatch_status wiring is absent', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-08-04T10:00:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_smoke',
    });
    createPassDb(rootDir);

    const missingSnapshot = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(missingSnapshot.overallReady, false);
    assert.deepEqual(missingSnapshot.failingSignals, ['router']);

    writeFileSync(
      join(rootDir, 'data', 'runtime-status-snapshot.json'),
      JSON.stringify({
        status: {
          probe: { healthy: true },
          wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: false },
        },
      }),
    );
    const missingWiring = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(missingWiring.overallReady, false);
    assert.deepEqual(missingWiring.failingSignals, ['router']);
    assert.equal(
      missingWiring.signals.find((signal) => signal.id === 'router').detail,
      'classification/healthz/dispatch_status null',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz settle canary signal requires the real settle-smoke artifact and attribution fields', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    writeFileSync(
      join(rootDir, 'data', 'runtime-status-snapshot.json'),
      JSON.stringify({
        status: {
          probe: { healthy: true },
          wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: true },
        },
      }),
    );
    createPassDb(rootDir);

    const missingArtifact = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(missingArtifact.overallReady, false);
    assert.deepEqual(missingArtifact.failingSignals, ['smoke']);

    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'fail',
      at: '2026-08-04T10:00:00.000Z',
      dispatched: true,
      settled: false,
      attributed: false,
      workerRunId: null,
      detail: 'settle smoke did not settle cleanly: status=failed',
    });
    const failedArtifact = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(failedArtifact.overallReady, false);
    assert.deepEqual(failedArtifact.failingSignals, ['smoke']);
    assert.match(
      failedArtifact.signals.find((signal) => signal.id === 'smoke').detail,
      /did not settle cleanly: status=failed/,
    );

    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-08-04T10:00:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: null,
    });
    const missingWorkerRun = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(missingWorkerRun.overallReady, false);
    assert.deepEqual(missingWorkerRun.failingSignals, ['smoke']);
    assert.equal(
      missingWorkerRun.signals.find((signal) => signal.id === 'smoke').detail,
      'PASS workerRunId missing',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz attribution signal fails when any recent SDK pass lacks worker_run_id', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    seedHealthyRuntime(rootDir);
    const db = new Database(join(rootDir, 'data', 'reviews.db'));
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
    ).run(null, 'completed', JSON.stringify({ launchRequestId: 'lrq_missing' }));
    db.close();

    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['attribution']);
    assert.equal(
      model.signals.find((signal) => signal.id === 'attribution').detail,
      'last 2 SDK passes: 1 attributed',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz attribution signal fails closed when no recent ended_at rows exist', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    writeFileSync(
      join(rootDir, 'data', 'runtime-status-snapshot.json'),
      JSON.stringify({
        status: {
          probe: { healthy: true },
          wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: true },
        },
      }),
    );
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-08-04T10:00:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_smoke',
    });
    createPassDb(rootDir, {
      endedAt: '2026-08-02T09:00:00.000Z',
      workerRunId: 'wr_old',
    });

    const model = await buildReadyzStatus(rootDir, {
      ...registeredAppRegistrationOptions(),
      now: () => new Date('2026-08-04T10:00:00.000Z'),
    });
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['attribution']);
    assert.equal(
      model.signals.find((signal) => signal.id === 'attribution').detail,
      'no recent SDK passes found',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz skips JSON-filtered attribution scan when no recent ended_at rows exist', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  const originalPrepare = Database.prototype.prepare;
  try {
    writeFileSync(
      join(rootDir, 'data', 'runtime-status-snapshot.json'),
      JSON.stringify({
        status: {
          probe: { healthy: true },
          wiring: { takeClassification: true, checkHealthz: true, dispatchStatus: true },
        },
      }),
    );
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-08-04T10:00:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_smoke',
    });
    createPassDb(rootDir, {
      endedAt: '2026-08-02T09:00:00.000Z',
      workerRunId: 'wr_old',
    });

    Database.prototype.prepare = function patchedPrepare(sql, ...args) {
      if (String(sql).includes('json_valid(metadata_json)')) {
        throw new Error('JSON-filtered attribution query should not run when no recent ended_at rows exist');
      }
      return originalPrepare.call(this, sql, ...args);
    };

    const model = await buildReadyzStatus(rootDir, {
      ...registeredAppRegistrationOptions(),
      now: () => new Date('2026-08-04T10:00:00.000Z'),
    });
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['attribution']);
    assert.equal(
      model.signals.find((signal) => signal.id === 'attribution').detail,
      'no recent SDK passes found',
    );
  } finally {
    Database.prototype.prepare = originalPrepare;
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz ignores malformed metadata and active or cli-direct passes while checking attribution', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    seedHealthyRuntime(rootDir);
    const db = new Database(join(rootDir, 'data', 'reviews.db'));
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
    ).run('wr_bad', 'completed', '{not json');
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
    ).run(null, 'running', JSON.stringify({ launchRequestId: 'lrq_running' }));
    db.prepare(
      'INSERT INTO reviewer_passes (worker_run_id, status, metadata_json) VALUES (?, ?, ?)'
    ).run(null, 'completed', '{}');
    db.close();

    const model = await buildReadyzStatus(rootDir, registeredAppRegistrationOptions());
    assert.equal(model.overallReady, true);
    assert.deepEqual(model.failingSignals, []);
    assert.equal(
      model.signals.find((signal) => signal.id === 'attribution').detail,
      'last 1 SDK passes: 1 attributed',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readyz app registration signal fails when adversarial-review resolves from the fallback default', async () => {
  const rootDir = makeRoot();
  const restoreFetch = withFetch(healthyEndpointPayload());
  try {
    seedHealthyRuntime(rootDir);
    const model = await buildReadyzStatus(rootDir, {
      appRegistrationOptions: {
        loadConfigImpl: () => ({
          get(_key, defaultValue = null) {
            return defaultValue;
          },
          sources: {},
        }),
      },
    });
    assert.equal(model.overallReady, false);
    assert.deepEqual(model.failingSignals, ['app-registration']);
    assert.equal(
      model.signals.find((signal) => signal.id === 'app-registration').detail,
      'default, fallback default',
    );
  } finally {
    restoreFetch();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
