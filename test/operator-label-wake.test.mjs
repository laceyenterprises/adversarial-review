import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabelControlObservationCache, observeOperatorLabelWakes, OPERATOR_WAKE_LABELS } from '../src/operator-label-wake.mjs';
import { createGitHubPRLabelControlsAdapter } from '../src/adapters/operator/github-pr-label-controls/index.mjs';
import { createNoProgressLaneGate, handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { noProgressLaneFilePath, operatorDecisionAlertStateDir, readNoProgressLane, recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { createWatcherWakeSource } from '../src/watcher-wake.mjs';
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
    now: () => Date.parse('2026-10-04T14:00:00Z'), env: {},
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(await observeOperatorLabelWakes({
        ...args, requestWatcherWakeImpl: () => { throw new Error('wake unavailable'); },
      }), []);
      assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
    }
    const dir = join(rootDir, 'data', 'operator-label-wakes');
    assert.equal(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).outcome, 'reserved');
    assert.equal((await observeOperatorLabelWakes(args)).length, 1);
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: an interrupted reservation delivers a new wake after restart', async () => {
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
    const source = createWatcherWakeSource({
      rootDir, logger, consumeExistingOnStart: true, rateLimiter: null,
      loadConfigImpl: () => ({ getHandoffConfig: () => ({}) }),
      recordHandoffWakeEventsImpl: () => {},
    });
    try {
      assert.equal(source.consumeCurrent().request_id, requestId);
      assert.equal((await observeOperatorLabelWakes({ ...args, now: () => args.now() + 86400000 })).length, 1);
      const delivered = source.consumeCurrent();
      assert.ok(delivered);
      assert.notEqual(delivered.request_id, requestId);
      assert.equal(source.consumeCurrent(), null);
    } finally { source.close(); }
    assert.equal(readNoProgressLane(rootDir, identity), null);
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

for (const createdAt of ['2026-10-03T14:00:00Z', 'invalid', '2026-10-04T14:01:00Z']) {
  test(`LABELWAKE-01: unreceipted event outside freshness window (${createdAt}) preserves lane`, async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
    try {
      park(rootDir);
      assert.deepEqual(await observeOperatorLabelWakes(observation(rootDir, 'operator-approved', { createdAt })), []);
      assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test('LABELWAKE-01: configurable freshness window admits a recent delayed event', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    const args = observation(rootDir, 'operator-approved', { createdAt: '2026-10-04T13:00:00Z' });
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
    assert.equal((await observeOperatorLabelWakes({
      ...args, env: { ADVERSARIAL_OPERATOR_LABEL_WAKE_MAX_AGE_MS: '7200000' },
    })).length, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: corrupt receipt recovers and a failed label does not hide later labels', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    const args = observation(rootDir, 'operator-approved');
    await observeOperatorLabelWakes(args);
    const dir = join(rootDir, 'data', 'operator-label-wakes');
    const receipt = join(dir, readdirSync(dir)[0]);
    writeFileSync(receipt, '{truncated');
    park(rootDir);
    const warnings = [];
    assert.equal((await observeOperatorLabelWakes({
      ...args, labelNames: ['merge-agent-requested', 'operator-approved'],
      logger: { warn: (message) => warnings.push(message) },
      observeLabelControlImpl: (ref, head, label) => {
        if (label === 'merge-agent-requested') throw new Error('timeline unavailable');
        return args.operatorSurface.observeLabelControl(ref, head, label);
      },
    })).length, 1);
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).outcome, 'requested');
    assert.equal(readNoProgressLane(rootDir, identity), null);
    assert.ok(warnings.some((message) => message.includes('corrupt operator label wake receipt')));
    assert.ok(warnings.some((message) => message.includes('timeline unavailable')));
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: debounce clear failure keeps receipt reserved and lane intact', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    park(rootDir);
    writeFileSync(operatorDecisionAlertStateDir(rootDir), 'wedged directory');
    const args = observation(rootDir, 'operator-approved');
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
    assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
    const dir = join(rootDir, 'data', 'operator-label-wakes');
    assert.equal(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).outcome, 'reserved');
    rmSync(operatorDecisionAlertStateDir(rootDir));
    assert.equal((await observeOperatorLabelWakes(args)).length, 1);
    assert.equal(readNoProgressLane(rootDir, identity), null);
    assert.equal(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).outcome, 'requested');
    // Completed recovery must deduplicate even when the PR parks again.
    park(rootDir);
    assert.deepEqual(await observeOperatorLabelWakes(args), []);
    assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, 7);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('LABELWAKE-01: discovery cache reuses wake observations for retrigger consumers only within a pass', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-wake-'));
  try {
    const args = observation(rootDir, 'retrigger-review');
    let calls = 0;
    const surface = { observeLabelControl: async (...params) => {
      calls += 1;
      return args.operatorSurface.observeLabelControl(...params);
    } };
    const observe = createLabelControlObservationCache(surface);
    await observeOperatorLabelWakes({ ...args, observeLabelControlImpl: observe });
    assert.equal((await observe(args.subjectRef, headSha, 'retrigger-review')).eventId, 'event-1');
    assert.equal(calls, 1);
    await observe(args.subjectRef, 'another-head', 'retrigger-review');
    await observe(args.subjectRef, headSha, 'retrigger-remediation');
    await createLabelControlObservationCache(surface)(args.subjectRef, headSha, 'retrigger-review');
    assert.equal(calls, 4);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
