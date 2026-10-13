// Non-budget remediation stops still require a visible operator decision.
// Budget exhaustion is handed to the hammer instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { processReviewSubject } from '../src/pollonce-phases.mjs';
import { maybeFireOperatorDecisionRequiredAlert } from '../src/watcher-no-progress-lane.mjs';
import { getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  hasOperatorDecisionRequiredAlerted,
  markOperatorDecisionRequiredAlerted,
  readCascadeState,
} from '../src/reviewer-cascade.mjs';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'odr-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

async function withRootAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), 'odr-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

import { maybeDeliverOperatorDecisionNotice, recordOperatorNoticeCloserOutcome,
  OPERATOR_DECISION_NOTICE_BACKSTOP_MS } from '../src/operator-decision-notice.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-closer.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO = 'o/r';

test('withheld-head failure retries failed delivery and debounces only after queuing', async () => {
  await withRootAsync(async (rootDir) => {
    const options = { rootDir, identity: { repo: REPO, prNumber: 1 }, headSha: HEAD,
      fingerprint: `withheld-head-review:${HEAD}`, operatorReason: 'withheld-head-review-failed',
      noProgressTicks: 1, thresholdTicks: 1 };
    await assert.rejects(maybeFireOperatorDecisionRequiredAlert({ ...options,
      deliverAlertFn: async () => { throw new Error('queue unavailable'); } }), /queue unavailable/);
    const alerts = [];
    const deliverAlertFn = async (text, meta) => alerts.push({ text, meta });
    assert.equal(await maybeFireOperatorDecisionRequiredAlert({ ...options, deliverAlertFn }), true);
    assert.equal(await maybeFireOperatorDecisionRequiredAlert({ ...options, deliverAlertFn }), false);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /terminal.*normal retry policy/);
    assert.equal(alerts[0].meta.payload.reason, 'withheld-head-review-failed');
  });
});

function writeStoppedRequestChangesJob(root, stopCode = 'manual-stop') {
  const dir = getFollowUpJobDir(root, 'stopped');
  mkdirSync(dir, { recursive: true });
  writeFollowUpJob(join(dir, 'o-r-pr-1.json'), {
    schemaVersion: 1,
    kind: 'adversarial-review-follow-up',
    status: 'stopped',
    jobId: 'o-r-pr-1',
    createdAt: '2026-09-04T12:00:00.000Z',
    stoppedAt: '2026-09-04T12:10:00.000Z',
    repo: REPO,
    prNumber: 1,
    domainId: 'github-pr',
    subjectExternalId: `${REPO}#1`,
    revisionRef: HEAD,
    reviewerModel: 'gemini',
    reviewBody: '## Summary\nStill blocked.\n\n## Verdict\nRequest changes',
    remediationPlan: {
      currentRound: 3,
      maxRounds: 3,
      stop: { code: stopCode },
    },
    remediationWorker: { state: 'completed' },
  });
}

async function runMergedPostedSubject(root, { deliverAlertFn, errors = [], stopCode } = {}) {
  writeStoppedRequestChangesJob(root, stopCode);
  await processReviewSubject({
    subject: {
      title: '[codex] operator decision fixture',
      labels: [],
      headSha: HEAD,
      ref: { revisionRef: HEAD, subjectExternalId: `${REPO}#1` },
    },
    prNumber: 1,
    current: {
      review_status: 'posted',
      pr_state: 'merged',
      reviewer_head_sha: HEAD,
      review_attempts: 1,
      posted_at: '2026-09-04T12:00:00.000Z',
      failed_at: null,
      merged_at: '2026-09-04T12:15:00.000Z',
    },
  }, {
    operatorSurface: { extractLinearTicketId: () => null },
    watcherDrain: { active: false },
    postedReviewHandlers: [],
    domainId: 'github-pr',
    repoPath: REPO,
    currentRepoPRs: [],
    activeMergeAgentPRs: [],
    ROOT: root,
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    WATCHER_PRIMARY_DOMAIN_ID: 'github-pr',
    deliverAlertFn,
    adversarialGateProvider: {
      async gate(_subject, revisionRef, decision) {
        return {
          gated: true,
          providerId: 'fixture-gate',
          revisionRef,
          publish: { posted: true, reason: 'fixture', decision },
        };
      },
    },
    shouldDeferReviewForActiveFollowUp: () => ({ defer: false }),
    handlePollError: () => {},
  });
  return errors;
}

test('alerts once for a given head', () => {
  withRoot((root) => {
    const args = { repo: 'o/r', prNumber: 1, headSha: 'aaa', reason: 'remediation-stopped' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, true,
      'first observation of a head must alert');
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, false,
      'repeat polls on the same head must not re-page');
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, false);
  });
});

test('a new head re-arms the alert', () => {
  withRoot((root) => {
    const base = { repo: 'o/r', prNumber: 1, reason: 'remediation-stopped' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'aaa' }).marked, true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'aaa' }).marked, false);
    // A push is a fresh chance to converge, so the operator is told again.
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'bbb' }).marked, true,
      'a new head must re-arm; otherwise one alert covers the PR forever');
  });
});

test('missing head sha is a valid dedupe key', () => {
  withRoot((root) => {
    const base = { repo: 'o/r', prNumber: 1, reason: 'remediation-stopped' };
    assert.equal(hasOperatorDecisionRequiredAlerted(root, base), false);
    assert.equal(markOperatorDecisionRequiredAlerted(root, base).marked, true);
    assert.equal(readCascadeState(root, { repo: 'o/r', prNumber: 1 }).operatorDecisionAlertedHeadSha, null);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, base), true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, base).marked, false,
      'repeat polls without a head sha must not re-page');
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'bbb' }).marked, true,
      'a later observed head still re-arms the alert');
  });
});

test('per-PR isolation', () => {
  withRoot((root) => {
    const a = { repo: 'o/r', prNumber: 1, headSha: 'aaa' };
    const b = { repo: 'o/r', prNumber: 2, headSha: 'aaa' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, a).marked, true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, b).marked, true,
      'a different PR must alert on its own');
  });
});

test('the mark records why, for the operator reading state later', () => {
  withRoot((root) => {
    const res = markOperatorDecisionRequiredAlerted(root, {
      repo: 'o/r', prNumber: 3, headSha: 'ccc', reason: 'remediation-stopped',
    });
    assert.equal(res.state.operatorDecisionAlert.reason, 'remediation-stopped');
    assert.equal(res.state.operatorDecisionAlertedHeadSha, 'ccc');
    assert.ok(res.state.operatorDecisionAlertedAt);
  });
});

test('the watcher never notifies an already merged PR', async () => {
  await withRootAsync(async (root) => {
    const alerts = [];
    await runMergedPostedSubject(root, {
      deliverAlertFn: async (text) => alerts.push(text),
    });
    assert.equal(alerts.length, 0);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, { repo: REPO, prNumber: 1, headSha: HEAD }), false);
  });
});


const identity = { repo: REPO, prNumber: 1, headSha: HEAD };
const decision = { operatorDecisionRequired: true, state: 'success', reason: 'remediation-stopped' };
function fixtureJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function noticeFixture(rootDir) {
  const alerts = [], logs = [];
  return { alerts, logs, options: { rootDir, ...identity, decision, now: 0,
    deliverAlertFn: async (text, meta) => alerts.push({ text, meta }),
    logger: { log: line => logs.push(line) } } };
}

for (const route of ['lease', 'eligible', 'pending', 'in-progress', 'handoff', 'dispatch']) {
  test(`notice held while ${route} route remains, including past backstop`, async () => {
    await withRootAsync(async root => {
      const { alerts, logs, options } = noticeFixture(root);
      if (route === 'lease' || route === 'handoff') fixtureJSON(amaCloserLeaseFilePath(root, identity), {
        ...identity, status: route === 'lease' ? 'pending' : 'handed-to-review' });
      if (route === 'eligible') recordOperatorNoticeCloserOutcome(root, identity,
        { closureOwner: { owner: 'hammer' }, dispatched: false });
      if (route === 'dispatch') fixtureJSON(amaCloserDispatchFilePath(root, identity), {
        ...identity, state: 'dispatched', lastObservedStatus: 'running' });
      if (['pending', 'in-progress'].includes(route)) writeFollowUpJob(join(getFollowUpJobDir(root, route === 'in-progress' ? 'inProgress' : route), 'synthetic.json'), {
        ...identity, status: route, kind: 'adversarial-review-follow-up' });
      for (const now of [0, 44 * 60_000, 60 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...options, now,
        reviewRow: { review_status: 'pending' } });
      assert.equal(alerts.length, 0);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /notice held/);
      assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    });
  });
}

for (const reason of ['no-route', 'hammer-ended-without-merge', 'backstop-45m']) {
  test(`notice delivers once for ${reason} with identical wording`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      if (reason === 'no-route') recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true, reason: 'hammer-retry-cap' });
      if (reason === 'hammer-ended-without-merge') fixtureJSON(amaCloserDispatchFilePath(root, identity), {
        ...identity, state: 'dispatched', workerClass: 'hammer', launchRequestId: 'synthetic-launch', lastObservedStatus: 'failed', outcome: 'failed-without-merge', lastError: 'synthetic-stop' });
      if (reason === 'backstop-45m') {
        await maybeDeliverOperatorDecisionNotice(options);
        await maybeDeliverOperatorDecisionNotice({ ...options, now: 44 * 60_000 });
        assert.equal(alerts.length, 0);
      }
      await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
      await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS + 1 });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, reason);
      if (reason === 'hammer-ended-without-merge') assert.equal(alerts[0].meta.payload.hammer_stop_reason, 'synthetic-stop');
      assert.equal(alerts[0].text, 'Adversarial review needs an operator decision for o/r#1: success (remediation-stopped). Findings are unresolved and remediation will not run again on this head. The PR will not merge until someone remediates or explicitly approves.');
      assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), true);
    });
  });
}

test('delivery failure leaves marker unset and retries later', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    await assert.rejects(maybeDeliverOperatorDecisionNotice({ ...options,
      deliverAlertFn: async () => { throw new Error('synthetic failure'); } }), /synthetic failure/);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    await maybeDeliverOperatorDecisionNotice(options);
    assert.equal(alerts.length, 1);
  });
});

test('merge or closure while held prevents delivery, including a stale discovery', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    await maybeDeliverOperatorDecisionNotice(options);
    for (const state of ['MERGED', 'CLOSED']) await maybeDeliverOperatorDecisionNotice({ ...options,
      now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS, readLivePR: async () => ({ state, headRefOid: HEAD }) });
    await maybeDeliverOperatorDecisionNotice({ ...options, terminal: true, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts.length, 0);
  });
});

test('head advance starts a fresh backstop and never notifies stale head', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    await maybeDeliverOperatorDecisionNotice(options);
    const headSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS,
      readLivePR: async () => ({ state: 'OPEN', headRefOid: headSha }) });
    await maybeDeliverOperatorDecisionNotice({ ...options, headSha, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts.length, 0);
    await maybeDeliverOperatorDecisionNotice({ ...options, headSha, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS * 2 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.payload.head_sha, headSha);
  });
});

test('active ownership takes precedence over an operator outcome and the backstop', async () => {
  await withRootAsync(async root => {
    const { alerts, logs, options } = noticeFixture(root);
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true, reason: 'synthetic-hold' });
    const path = amaCloserLeaseFilePath(root, identity);
    fixtureJSON(path, { ...identity, status: 'dispatched' });
    for (const now of [0, 44 * 60_000, 60 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...options, now });
    assert.equal(alerts.length, 0);
    assert.equal(logs.length, 1);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    rmSync(path);
    await maybeDeliverOperatorDecisionNotice({ ...options, now: 60 * 60_000 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.payload.reason, 'no-route');
  });
});

test('a new head does not inherit the previous head operator outcome', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    const headSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await maybeDeliverOperatorDecisionNotice({ ...options, headSha });
    assert.equal(alerts.length, 0);
    await maybeDeliverOperatorDecisionNotice({ ...options, headSha, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.payload.reason, 'backstop-45m');
  });
});

test('a queued retry keeps ownership after the previous hammer ended', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity,
      workerClass: 'hammer', launchRequestId: 'synthetic-launch', state: 'dispatched',
      lastObservedStatus: 'failed', outcome: 'failed-without-merge' });
    recordOperatorNoticeCloserOutcome(root, identity, { dispatched: false,
      backgroundDispatch: { state: 'queued' } });
    await maybeDeliverOperatorDecisionNotice(options);
    await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts.length, 0);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
  });
});
