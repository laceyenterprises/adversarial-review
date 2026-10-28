import './helpers/dispatch-files-preload.mjs';
/* Routine SIGTERM must preserve in-flight reviewer
 * subprocesses. The next watcher reattaches them via
 * `reconcileReviewerSessions` (the `reviewer_reattach_alive` branch).
 *
 * A separate hard-shutdown command owns the intentional cancel-first path.
 * See `docs/SPEC-adversarial-review-auto-remediation.md` for the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  shouldPreserveReviewersOnSigterm,
  readWatcherDrainState,
  shouldReconcileReviewerSession,
} from '../src/watcher.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

test('preserves reviewers when drain marker is active', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(drainFile, JSON.stringify({
      reason: 'main-catchup deploy 2026-05-16',
      requestedBy: 'main-catchup',
      expiresAt: farFuture,
    }));

    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, true);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('preserves reviewers when no drain marker is present (default SIGTERM bounce)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-nodrain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    // Marker absent.
    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, false);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('preserves reviewers when drain marker has expired', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-expired-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    // Past expiresAt — marker is on disk but logically inert.
    writeFileSync(drainFile, JSON.stringify({
      reason: 'old drain',
      requestedBy: 'main-catchup',
      expiresAt: '2024-01-01T00:00:00.000Z',
    }));

    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, false);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shouldPreserveReviewersOnSigterm tolerates missing or partial drain state', () => {
  assert.equal(shouldPreserveReviewersOnSigterm(undefined), true);
  assert.equal(shouldPreserveReviewersOnSigterm(null), true);
  assert.equal(shouldPreserveReviewersOnSigterm({}), true);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: false }), true);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: true }), true);
});

test('poll reconcile includes adopted reviewer sessions before timeout expiry', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-adopted-reviewer-'));
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'adopted-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      adoptedAfterBounce: true,
      spawnedAt: '2026-05-26T10:00:00.000Z',
      lastHeartbeatAt: '2026-05-26T10:01:00.000Z',
    });

    assert.equal(shouldReconcileReviewerSession(
      {
        reviewer_session_uuid: 'adopted-session',
        reviewer_started_at: '2026-05-26T10:00:00.000Z',
        reviewer_timeout_ms: 60 * 60 * 1000,
      },
      new Date('2026-05-26T10:05:00.000Z'),
      { rootDir },
    ), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`CLOSERDISPATCHDEAD-01: ${signal} interrupts background work before reviewer cleanup`, async t => {
  const { parse } = await import('acorn');
  const { runInNewContext } = await import('node:vm');
  const { amaHammerBackgroundQueue, shutdownAmaHammerBackgroundQueue,
    resetAmaHammerBackgroundQueueForTests } = await import('../src/ama-hammer-background-dispatch.mjs');
  resetAmaHammerBackgroundQueueForTests();
  t.after(resetAmaHammerBackgroundQueueForTests);
  const queue = amaHammerBackgroundQueue();
  let interrupted = false;
  queue.submit({ key: 'example/repo#8@head', run: abortSignal => new Promise(resolve => {
    abortSignal.addEventListener('abort', () => { interrupted = true; resolve({ dispatched: false }); }, { once: true });
  }) });
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const statement = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(node =>
    node.type === 'ExpressionStatement' && node.expression.callee?.object?.name === 'process'
    && node.expression.callee?.property?.name === 'on' && node.expression.arguments[0]?.value === signal);
  assert.ok(statement);
  let handler, exited = false;
  runInNewContext(source.slice(statement.start, statement.end), {
    process: { env: {}, on: (_signal, callback) => { handler = callback; } },
    shutdownAmaHammerBackgroundQueue,
    readWatcherDrainState: () => ({}), shouldPreserveReviewersOnSigterm: () => true,
    resolveSigtermFenceMode: () => 'on',
    waitForActiveReviewerFencesOnSigterm: async () => { assert.equal(interrupted, true); },
    exitAfterReviewerCleanup: () => { assert.equal(interrupted, true); exited = true; },
    console: { error: message => assert.fail(message) },
  });
  handler();
  assert.equal(interrupted, true);
  await queue.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exited, true);
});
