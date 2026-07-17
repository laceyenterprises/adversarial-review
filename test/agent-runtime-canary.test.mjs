import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalAgentRuntime } from '../src/adapters/agent-runtime/local/index.mjs';
import {
  runFallbackCanary,
  createFixtureReviewerInner,
  readCanaryStatus,
} from '../src/adapters/agent-runtime/canary.mjs';
import { summarizeRuntimeRuns } from '../src/adapters/agent-runtime/run-ledger.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'canary-'));
}

// A permissive admission so the fixture canary never trips the memory/quota
// probes on a CI host; the point of the CI canary is the port + verdict + alert
// path, not the (separately tested) admission gates.
function admitAll() {
  return { admit: true, budget: { requestedTokens: 200_000, requestedWallMs: 300_000 } };
}

function fixtureLocalRuntime(rootDir, inner = createFixtureReviewerInner()) {
  return createLocalAgentRuntime({ rootDir, cliDirect: inner, admissionImpl: admitAll });
}

test('a healthy fixture canary PASSes, writes the status file, and records a ledger run', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T06:00:12.000Z');
    let paged = false;
    const outcome = await runFallbackCanary({
      rootDir,
      localRuntime: fixtureLocalRuntime(rootDir),
      now,
      deliverAlertFn: async () => { paged = true; },
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status.status, 'pass');
    assert.equal(outcome.status.verdictKind, 'comment-only');
    assert.equal(paged, false, 'a passing canary must not page');

    const persisted = readCanaryStatus(rootDir);
    assert.equal(persisted.status, 'pass');
    assert.equal(persisted.at, '2026-07-17T06:00:12.000Z');
    assert.equal(persisted.mode, 'local');

    const runs = summarizeRuntimeRuns(rootDir, { now });
    assert.equal(runs.local, 1);
    assert.equal(runs.canary, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a canary whose local runtime fails to complete FAILs and PAGES', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T06:00:12.000Z');
    const brokenInner = createFixtureReviewerInner();
    brokenInner.spawnReviewer = async () => ({
      ok: false,
      reviewBody: null,
      failureClass: 'reviewer-command-failed',
      stderrTail: 'boom',
      stdoutTail: null,
      exitCode: 1,
      signal: null,
      pgid: null,
      spawnedAt: now().toISOString(),
      reattachToken: null,
    });

    const alerts = [];
    const outcome = await runFallbackCanary({
      rootDir,
      localRuntime: fixtureLocalRuntime(rootDir, brokenInner),
      now,
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status.status, 'fail');
    assert.equal(alerts.length, 1, 'a failing canary must page exactly once');
    assert.equal(alerts[0].meta.event, 'runtime.canary.failed');
    assert.match(alerts[0].text, /fallback canary FAILED/i);

    assert.equal(readCanaryStatus(rootDir).status, 'fail');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a canary that completes but produces no parseable verdict FAILs', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T06:00:12.000Z');
    const junkInner = createFixtureReviewerInner({ reviewBody: 'not a review at all' });

    const alerts = [];
    const outcome = await runFallbackCanary({
      rootDir,
      localRuntime: fixtureLocalRuntime(rootDir, junkInner),
      now,
      deliverAlertFn: async (text) => { alerts.push(text); },
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.status.detail, /no parseable verdict/);
    assert.equal(alerts.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a page-delivery failure does not throw out of the canary', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T06:00:12.000Z');
    const brokenInner = createFixtureReviewerInner();
    brokenInner.spawnReviewer = async () => ({ ok: false, reviewBody: null, failureClass: 'bug', stderrTail: 'x', stdoutTail: null, exitCode: 1, signal: null, pgid: null, spawnedAt: now().toISOString(), reattachToken: null });

    const outcome = await runFallbackCanary({
      rootDir,
      localRuntime: fixtureLocalRuntime(rootDir, brokenInner),
      now,
      deliverAlertFn: async () => { throw new Error('alert bridge down'); },
      logger: { error() {}, warn() {} },
    });
    assert.equal(outcome.ok, false, 'canary still reports fail even when paging itself fails');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
