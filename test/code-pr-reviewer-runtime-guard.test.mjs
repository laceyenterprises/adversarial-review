import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SETTLE_SMOKE_FRESHNESS_WINDOW_MS,
  settleSmokeResultPath,
  writeSettleSmokeResult,
} from '../src/adapters/agent-runtime/settle-smoke.mjs';
import {
  evaluateAgentRuntimeCutoverReadiness,
  KNOWN_REVIEWER_RUNTIME_NAMES,
} from '../src/reviewer-runtime-cutover.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'code-pr-reviewer-runtime-guard-'));
}

function writeCodePrDomain(rootDir, overrides = {}) {
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  writeFileSync(join(rootDir, 'domains', 'code-pr.json'), JSON.stringify({
    id: 'code-pr',
    reviewerRuntime: 'agent-runtime',
    ...overrides,
  }));
}

function readyReadiness(rootDir, now) {
  return evaluateAgentRuntimeCutoverReadiness({
    rootDir,
    domainConfig: { id: 'code-pr', reviewerRuntime: 'agent-runtime' },
    orchestrationMode: 'agentos',
    now: () => new Date(now),
    readSnapshotImpl: () => ({ status: { mode: 'os', config: { enabled: true }, probe: { healthy: true } } }),
    readCanaryImpl: () => ({ status: 'pass', at: now }),
  });
}

test('checked-in domain configs only request known reviewer runtimes', () => {
  const domainsDir = join(repoRoot, 'domains');
  const domainFiles = readdirSync(domainsDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const knownRuntimeList = [...KNOWN_REVIEWER_RUNTIME_NAMES].sort().join(', ');

  for (const fileName of domainFiles) {
    const domain = JSON.parse(readFileSync(join(domainsDir, fileName), 'utf8'));
    const runtime = String(domain.reviewerRuntime || 'cli-direct').trim() || 'cli-direct';
    assert.ok(
      KNOWN_REVIEWER_RUNTIME_NAMES.has(runtime),
      `${fileName} reviewerRuntime='${runtime}' is not supported; use one of: ${knownRuntimeList}`,
    );
  }
});

test('agent-runtime is not settle-proven when the settle-smoke artifact is absent', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.selectedRuntime, 'agent-os-hq');
    assert.equal(readiness.reasons[0].code, 'settle-smoke-missing');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime is not settle-proven when the settle-smoke artifact is stale', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-07-25T09:59:59.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_stale',
    });
    const now = new Date('2026-08-02T10:00:00.000Z');
    const readiness = readyReadiness(rootDir, now.toISOString());
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reasons[0].code, 'settle-smoke-stale');
    assert.ok(
      now.getTime() - Date.parse('2026-07-25T09:59:59.000Z') > SETTLE_SMOKE_FRESHNESS_WINDOW_MS,
      'fixture must be older than the freshness window',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime is not settle-proven when the settle-smoke artifact recorded FAIL', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'fail',
      at: '2026-08-02T09:55:00.000Z',
      dispatched: true,
      settled: false,
      attributed: false,
      workerRunId: null,
      detail: 'artifactless dispatch',
    });
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reasons[0].code, 'settle-smoke-failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reports a malformed settle-smoke artifact distinctly from missing', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pending',
      at: '2026-08-02T09:55:00.000Z',
      dispatched: true,
      settled: false,
      attributed: false,
      workerRunId: null,
    });
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reasons[0].code, 'settle-smoke-invalid');
    assert.match(readiness.reasons[0].message, /malformed \(invalid-status\)/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reports invalid JSON settle-smoke artifacts distinctly from missing', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    mkdirSync(join(rootDir, 'data', 'runtime-settle-smoke'), { recursive: true });
    writeFileSync(settleSmokeResultPath(rootDir, 'agent-runtime'), '{not-json');
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reasons[0].code, 'settle-smoke-invalid');
    assert.match(readiness.reasons[0].message, /malformed \(invalid-json\)/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime rejects an unsupported settle-smoke schema distinctly from missing', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    mkdirSync(join(rootDir, 'data', 'runtime-settle-smoke'), { recursive: true });
    writeFileSync(settleSmokeResultPath(rootDir, 'agent-runtime'), JSON.stringify({
      schema_version: 2,
      runtime: 'agent-runtime',
      status: 'pass',
      at: '2026-08-02T09:55:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_future_schema',
    }));
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reasons[0].code, 'settle-smoke-invalid');
    assert.match(readiness.reasons[0].message, /malformed \(unsupported-schema-version\)/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime is settle-proven only when a fresh PASS artifact is present', () => {
  const rootDir = makeRoot();
  try {
    writeCodePrDomain(rootDir);
    writeSettleSmokeResult(rootDir, 'agent-runtime', {
      status: 'pass',
      at: '2026-08-02T09:55:00.000Z',
      dispatched: true,
      settled: true,
      attributed: true,
      workerRunId: 'wr_fresh',
    });
    const readiness = readyReadiness(rootDir, '2026-08-02T10:00:00.000Z');
    assert.equal(readiness.ready, true);
    assert.equal(readiness.selectedRuntime, 'agent-runtime');
    assert.equal(readiness.settleSmoke.result.workerRunId, 'wr_fresh');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
