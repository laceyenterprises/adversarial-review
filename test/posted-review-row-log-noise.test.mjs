import test from 'node:test';
import assert from 'node:assert/strict';

import { handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { createLogChangeGate } from '../src/log-change-gate.mjs';

// Drive handlePostedReviewRow straight to the AMA `ama-pending` retained-ownership
// branch with fully injected collaborators, then assert the LOG-ONLY line is
// emitted once per (repo, pr, head, reason) transition rather than every tick.
function baseArgs(overrides = {}) {
  const logs = [];
  const args = {
    rootDir: '/tmp/adversarial-review-log-noise',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 4242,
    existing: { body_md: null },
    subjectRef: null,
    currentRevisionRef: 'headsha-1',
    labelNames: [],
    projectGateStatusSafe: async () => {},
    fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open' }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: {
        reason: 'daemon-failed-closed',
        launchRequestId: 'lrq_stuck',
        workerClass: 'hammer',
      },
    }),
    latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => null,
    reviewBodyHasScopeViolationFindingImpl: () => false,
    operatorSurface: null,
    logger: { log: (m) => logs.push(String(m)) },
    ...overrides,
  };
  return { args, logs };
}

const retained = (logs) => logs.filter((m) => /AMA hammer route retained ownership/.test(m));

test('handlePostedReviewRow: retained-ownership logs once and is suppressed on unchanged repeats', async () => {
  const logGate = createLogChangeGate();
  const { args, logs } = baseArgs({ logGate });

  await handlePostedReviewRow(args);
  await handlePostedReviewRow(args);
  await handlePostedReviewRow(args);

  const lines = retained(logs);
  assert.equal(lines.length, 1, `expected one retained-ownership log, got ${lines.length}`);
  assert.match(lines[0], /laceyenterprises\/agent-os#4242/);
  assert.match(lines[0], /daemon-failed-closed/);
});

test('handlePostedReviewRow: retained-ownership re-logs when the head advances', async () => {
  const logGate = createLogChangeGate();
  const first = baseArgs({ logGate, currentRevisionRef: 'headsha-1' });
  const second = baseArgs({ logGate, currentRevisionRef: 'headsha-2' });

  await handlePostedReviewRow(first.args);
  await handlePostedReviewRow(first.args); // suppressed (same head + reason)
  await handlePostedReviewRow(second.args); // new head -> logs again

  assert.equal(retained(first.logs).length, 1);
  assert.equal(retained(second.logs).length, 1);
});

test('handlePostedReviewRow: retained-ownership re-logs when the reason changes on the same head', async () => {
  const logGate = createLogChangeGate();
  const a = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'daemon-failed-closed', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });
  const b = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'hammer-retry-cap-pending', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });

  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(a.args); // suppressed
  await handlePostedReviewRow(b.args); // changed reason -> logs again

  assert.equal(retained(a.logs).length, 1);
  assert.equal(retained(b.logs).length, 1);
  assert.match(retained(b.logs)[0], /hammer-retry-cap-pending/);
});
