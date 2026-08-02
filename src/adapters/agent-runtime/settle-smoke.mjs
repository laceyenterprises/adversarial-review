import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../atomic-write.mjs';
import { assertCanonicalOwner } from './append-only-owner.mjs';

const SETTLE_SMOKE_SCHEMA_VERSION = 1;
const SETTLE_SMOKE_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLE_SMOKE_DIR = ['data', 'runtime-settle-smoke'];

function settleSmokeResultPath(rootDir, runtime = 'agent-runtime') {
  return join(rootDir, ...SETTLE_SMOKE_DIR, `${runtime}.json`);
}

function readSettleSmokeResult(rootDir, runtime = 'agent-runtime') {
  try {
    const parsed = JSON.parse(readFileSync(settleSmokeResultPath(rootDir, runtime), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
}

function writeSettleSmokeResult(rootDir, runtime, result, { ownerGuardOptions } = {}) {
  const path = settleSmokeResultPath(rootDir, runtime);
  assertCanonicalOwner(rootDir, path, ownerGuardOptions);
  writeFileAtomic(
    path,
    `${JSON.stringify({
      schema_version: SETTLE_SMOKE_SCHEMA_VERSION,
      runtime,
      ...result,
    }, null, 2)}\n`,
    { overwrite: true },
  );
  return readSettleSmokeResult(rootDir, runtime);
}

function evaluateSettleSmokeResult(rootDir, {
  runtime = 'agent-runtime',
  now = () => new Date(),
  freshnessWindowMs = SETTLE_SMOKE_FRESHNESS_WINDOW_MS,
  readResultImpl = readSettleSmokeResult,
} = {}) {
  const result = readResultImpl(rootDir, runtime);
  if (!result) {
    return {
      runtime,
      result: null,
      ok: false,
      fresh: false,
      reason: 'missing',
      evaluatedAt: now().toISOString(),
      freshnessWindowMs,
    };
  }

  if (result.schema_version !== SETTLE_SMOKE_SCHEMA_VERSION) {
    return {
      runtime,
      result,
      ok: false,
      fresh: false,
      reason: 'unsupported-schema-version',
      evaluatedAt: now().toISOString(),
      freshnessWindowMs,
    };
  }

  const status = String(result.status || '').trim().toLowerCase();
  if (status !== 'pass') {
    return {
      runtime,
      result,
      ok: false,
      fresh: false,
      reason: status === 'fail' ? 'fail' : 'invalid-status',
      evaluatedAt: now().toISOString(),
      freshnessWindowMs,
    };
  }

  const atMs = Date.parse(String(result.at || ''));
  if (!Number.isFinite(atMs)) {
    return {
      runtime,
      result,
      ok: false,
      fresh: false,
      reason: 'invalid-at',
      evaluatedAt: now().toISOString(),
      freshnessWindowMs,
    };
  }

  const ageMs = Math.max(0, now().getTime() - atMs);
  if (ageMs > freshnessWindowMs) {
    return {
      runtime,
      result,
      ok: false,
      fresh: false,
      reason: 'stale',
      ageMs,
      evaluatedAt: now().toISOString(),
      freshnessWindowMs,
    };
  }

  return {
    runtime,
    result,
    ok: true,
    fresh: true,
    reason: 'pass',
    ageMs,
    evaluatedAt: now().toISOString(),
    freshnessWindowMs,
  };
}

export {
  SETTLE_SMOKE_FRESHNESS_WINDOW_MS,
  SETTLE_SMOKE_SCHEMA_VERSION,
  evaluateSettleSmokeResult,
  readSettleSmokeResult,
  settleSmokeResultPath,
  writeSettleSmokeResult,
};
