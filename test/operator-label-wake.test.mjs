import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOperatorLabelWakes, OPERATOR_WAKE_LABELS } from '../src/operator-label-wake.mjs';
import { createGitHubPRLabelControlsAdapter } from '../src/adapters/operator/github-pr-label-controls/index.mjs';
import { createNoProgressLaneGate, handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { noProgressLaneFilePath, readNoProgressLane, recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { COEXISTENCE_ACTION } from '../src/ama/coexistence.mjs';

const identity = { repo: 'fixture/repo', prNumber: 7681 };
const headSha = 'current-head';
const logger = { log() {}, warn() {}, error() {} };
function park(rootDir) {
  recordNoProgressLaneRun(rootDir, identity, { headSha, fingerprint: 'parked', logger });
  const path = noProgressLaneFilePath(rootDir, identity);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...ledger, noProgressTicks: 7, skippedTicks: 9, decisionResets: 5, lane: 'slow' }));
}
function observation(rootDir, label, event = {}) {
  return {
    rootDir, ...identity, headSha, labelNames: [label], logger,
    subjectRef: { subjectExternalId: 'fixture/repo#7681' },
    operatorSurface: createGitHubPRLabelControlsAdapter({
      fetchLatestLabelEventImpl: async () => ({
        id: 'event-1', actor: 'operator', headSha,
        createdAt: '2026-10-04T13:56:00Z', ...event,
      }),
    }),
  };
}

for (const label of OPERATOR_WAKE_LABELS) {
  test(`LABELWAKE-01: fresh ${label} resets a spent-cap lane exactly once`, async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
    try {
      park(rootDir);
      const args = observation(rootDir, label);
      assert.equal((await observeOperatorLabelWakes(args)).length, 1);
      assert.equal(readNoProgressLane(rootDir, identity), null);
      const wake = readFileSync(join(rootDir, 'data', 'watcher-wake.json'), 'utf8');
      assert.equal(JSON.parse(wake).pending_subjects[0].pr_number, 7681);
      park(rootDir);
      assert.deepEqual(await observeOperatorLabelWakes(args), []);
      assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
      assert.equal(readFileSync(join(rootDir, 'data', 'watcher-wake.json'), 'utf8'), wake);
      assert.equal((await observeOperatorLabelWakes(observation(rootDir, label, { id: 'event-2' }))).length, 1);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
}

for (const event of [{ headSha: 'stale-head' }, { actor: null }, { id: null }, { createdAt: null }]) {
  test(`LABELWAKE-01: rejected event ${JSON.stringify(event)} leaves backoff intact`, async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
    try {
      park(rootDir);
      assert.deepEqual(await observeOperatorLabelWakes(observation(rootDir, 'merge-agent-requested', event)), []);
      assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test('LABELWAKE-01: #7681 replay reaches merge-agent dispatch on the next tick', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    park(rootDir);
    const row = { review_status: 'posted', reviewer_head_sha: headSha };
    const laneGate = createNoProgressLaneGate({ rootDir, readReviewRow: () => row, logger });
    let dispatches = 0;
    const handler = {
      repoPath: identity.repo, prNumber: identity.prNumber, headSha,
      run: () => handlePostedReviewRow({
        rootDir, repoPath: identity.repo, prNumber: identity.prNumber,
        existing: row, currentRevisionRef: headSha, labelNames: ['merge-agent-requested'],
        projectGateStatusSafe: async () => ({}),
        fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open' }),
        buildMergeAgentDispatchJobImpl: () => ({ ...identity }),
        latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
        reviewBodyHasScopeViolationFindingImpl: () => false,
        currentReviewRowReader: () => row,
        resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
          coexistence: { action: COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK },
        }),
        dispatchMergeAgentForPRImpl: async (job) => {
          assert.equal(job.triggerOverride, 'merge-agent-requested');
          dispatches += 1;
          return { decision: 'dispatched' };
        }, logger,
      }),
    };
    assert.equal(laneGate.evaluate(handler).backoffTicks, 12);
    assert.equal(laneGate.evaluate(handler).run, false);
    await observeOperatorLabelWakes(observation(rootDir, 'merge-agent-requested'));
    const result = await runPostedReviewHandlersFairly({ handlers: [handler], laneGate, logger });
    assert.equal(result.ran, 1);
    assert.equal(result.failed, 0);
    assert.equal(dispatches, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: a failed wake remains retryable', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    park(rootDir);
    const args = observation(rootDir, 'merge-agent-requested');
    await assert.rejects(observeOperatorLabelWakes({
      ...args, requestWatcherWakeImpl: () => { throw new Error('wake unavailable'); },
    }), /wake unavailable/);
    assert.equal((await observeOperatorLabelWakes(args)).length, 1);
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: an interrupted reservation resumes with the same wake identity', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    const args = observation(rootDir, 'merge-agent-requested');
    await observeOperatorLabelWakes(args);
    const wakePath = join(rootDir, 'data', 'watcher-wake.json');
    const requestId = JSON.parse(readFileSync(wakePath, 'utf8')).request_id;
    const dir = join(rootDir, 'data', 'operator-label-wakes');
    const receipt = join(dir, readdirSync(dir)[0]);
    const audit = JSON.parse(readFileSync(receipt, 'utf8'));
    writeFileSync(receipt, JSON.stringify({ ...audit, outcome: 'reserved' }));
    park(rootDir);
    assert.equal((await observeOperatorLabelWakes(args)).length, 1);
    assert.equal(JSON.parse(readFileSync(wakePath, 'utf8')).request_id, requestId);
    assert.equal(readNoProgressLane(rootDir, identity), null);
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
