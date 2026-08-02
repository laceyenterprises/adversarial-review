import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SETTLE_SMOKE_FRESHNESS_WINDOW_MS, writeSettleSmokeResult } from '../src/adapters/agent-runtime/settle-smoke.mjs';
import { evaluateAgentRuntimeCutoverReadiness } from '../src/reviewer-runtime-cutover.mjs';

const SETTLE_PROVEN_REVIEWER_RUNTIMES = new Set(['cli-direct']);

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

test('cli-direct remains settle-proven unconditionally', () => {
  assert.equal(SETTLE_PROVEN_REVIEWER_RUNTIMES.has('cli-direct'), true);
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
