import './helpers/load-aware-timeout-fixture.mjs';
// Non-budget remediation stops still require a visible operator decision.
// Budget exhaustion is handed to the hammer instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { processReviewSubject } from '../src/pollonce-phases.mjs';
import { normalizePRSnapshot, stateFromSnapshot } from '../src/adapters/subject/github-pr/index.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
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
import { markHammerRetryCapExhausted } from '../src/ama/hammer-retry-cap.mjs';

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
  writeFollowUpJob(join(dir, 'o__r-pr-1-stopped.json'), {
    schemaVersion: 1,
    kind: 'adversarial-review-follow-up',
    status: 'stopped',
    jobId: 'o__r-pr-1-stopped',
    createdAt: '2026-09-04T12:00:00.000Z',
    stoppedAt: '2026-09-04T12:10:00.000Z',
    repo: REPO,
    prNumber: 1,
    domainId: 'github-pr',
    subjectExternalId: `${REPO}#1`,
    revisionRef: HEAD,
    reviewerModel: 'gemini',
    // Suppress unrelated merge dispatch after gate projection so this watcher
    // integration fixture cannot leave the offline notification path.
    reviewBody: '## Summary\nStill blocked.\n\n## Scope Violation Finding\n```json\n{"kind":"scope-violation"}\n```\n\n## Verdict\nRequest changes',
    remediationPlan: {
      currentRound: 3,
      maxRounds: 3,
      stop: { code: stopCode },
    },
    remediationWorker: { state: 'completed' },
  });
}

async function runPostedSubject(root, { deliverAlertFn, stopCode, prState = 'open', liveState = 'OPEN' } = {}) {
  writeStoppedRequestChangesJob(root, stopCode);
  const subject = stateFromSnapshot(normalizePRSnapshot(REPO, {
    number: 1, title: '[codex] operator decision fixture', labels: [],
    state: prState, headRefOid: HEAD,
  }), { completedRemediationRounds: 3, maxRemediationRounds: 3 });
  // The production adapter keeps an open PR non-terminal even after all
  // remediation rounds are complete. Merged/closed PRs alone are terminal.
  assert.equal(subject.terminal, prState !== 'open');
  const localDb = openReviewStateDb(root);
  ensureReviewStateSchema(localDb);
  localDb.prepare(`INSERT OR REPLACE INTO reviewed_prs
    (repo, pr_number, domain_id, reviewed_at, reviewer, review_status, pr_state, reviewer_head_sha, posted_at)
    VALUES (?, 1, 'github-pr', ?, 'gemini', 'posted', ?, ?, ?)`)
    .run(REPO, '2026-09-04T12:00:00.000Z', prState, HEAD, '2026-09-04T12:00:00.000Z');
  const current = localDb.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = 1').get(REPO);
  localDb.close();
  const postedReviewHandlers = [];
  await processReviewSubject({
    subject,
    prNumber: 1,
    current,
  }, {
    operatorSurface: { extractLinearTicketId: () => null },
    watcherDrain: { active: false },
    postedReviewHandlers,
    domainId: 'github-pr',
    repoPath: REPO,
    currentRepoPRs: [],
    activeMergeAgentPRs: [],
    ROOT: root,
    execFileAsync: async (_file, args) => {
      if (args[0] === 'api' && args.some(arg => arg === `repos/${REPO}/pulls/1/files`)) {
        return { stdout: '[]', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify({ state: liveState, headRefOid: HEAD, labels: [],
          isDraft: true, reviews: [], statusCheckRollup: [] }), stderr: '' };
      }
      assert.equal(args[0], 'api');
      assert.ok(args.includes('graphql'));
      return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
        state: liveState, headRefOid: HEAD, labels: { nodes: [] },
      } } } }), stderr: '' };
    },
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
  for (const handler of postedReviewHandlers) await handler.run();
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
    await runPostedSubject(root, {
      prState: 'merged',
      deliverAlertFn: async (text) => alerts.push(text),
    });
    assert.equal(alerts.length, 0);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, { repo: REPO, prNumber: 1, headSha: HEAD }), false);
  });
});


const identity = { repo: REPO, prNumber: 1, headSha: HEAD };
const decision = { operatorDecisionRequired: true, state: 'success', reason: 'remediation-stopped' };
function noticeStatePath(root) {
  const key = createHash('sha256').update(`${REPO}#1`).digest('hex');
  return join(root, 'data', 'operator-decision-notices', `${key}.json`);
}
function fixtureJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function noticeFixture(rootDir) {
  const alerts = [], logs = [];
  return { alerts, logs, options: { rootDir, ...identity, decision, now: 0,
    deliverAlertFn: async (text, meta) => alerts.push({ text, meta }),
    readLaunchRequestStatusImpl: async () => ({ ok: false, reason: 'synthetic-unavailable' }),
    logger: { log: line => logs.push(line) } } };
}

test('held observations use one atomic replacement per changed head and none on repeat polls', async t => {
  await withRootAsync(async root => {
    const { alerts, logs, options } = noticeFixture(root);
    const closer = { needsOperator: false, reason: 'synthetic-outcome' };
    recordOperatorNoticeCloserOutcome(root, identity, closer);
    const rename = fs.renameSync;
    let replacements = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === noticeStatePath(root)) replacements++;
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await maybeDeliverOperatorDecisionNotice(options);
      assert.equal(replacements, 1);
      assert.deepEqual(JSON.parse(readFileSync(noticeStatePath(root), 'utf8')), {
        closer: { headSha: HEAD, result: closer },
        observation: { headSha: HEAD, startedAt: 0 },
        heldHeads: { [HEAD]: true },
      });
      await maybeDeliverOperatorDecisionNotice({ ...options, now: 1 });
      assert.equal(replacements, 1);
      const nextHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await maybeDeliverOperatorDecisionNotice({ ...options, headSha: nextHead, now: 2 });
      assert.equal(replacements, 2);
      // An already-logged head still needs a fresh observation if it returns.
      await maybeDeliverOperatorDecisionNotice({ ...options, now: 3 });
      assert.equal(replacements, 3);
      const state = JSON.parse(readFileSync(noticeStatePath(root), 'utf8'));
      assert.deepEqual(state.observation, { headSha: HEAD, startedAt: 3 });
      assert.deepEqual(state.heldHeads, { [HEAD]: true, [nextHead]: true });
      assert.deepEqual(state.closer, { headSha: HEAD, result: closer });
      assert.equal(logs.length, 2);
      assert.equal(alerts.length, 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('immediate delivery persists the observation before live lookup without overwriting a newer outcome', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    const newerOutcome = { needsOperator: true, reason: 'updated-during-lookup' };
    await maybeDeliverOperatorDecisionNotice({ ...options, readLivePR: async () => {
      assert.deepEqual(JSON.parse(readFileSync(noticeStatePath(root), 'utf8')).observation,
        { headSha: HEAD, startedAt: 0 });
      recordOperatorNoticeCloserOutcome(root, identity, newerOutcome);
      return { state: 'OPEN', headRefOid: HEAD };
    } });
    assert.equal(alerts.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(noticeStatePath(root), 'utf8')).closer,
      { headSha: HEAD, result: newerOutcome });
  });
});

for (const route of ['no-route', 'backstop']) {
  test(`watcher delivers once on an open PR with stopped remediation after ${route}`, async () => {
    await withRootAsync(async root => {
      const alerts = [];
      if (route === 'no-route') recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
      else fixtureJSON(noticeStatePath(root), {
        observation: { headSha: HEAD, startedAt: Date.now() - OPERATOR_DECISION_NOTICE_BACKSTOP_MS },
      });
      const options = { deliverAlertFn: async (text, meta) => alerts.push({ text, meta }) };
      await runPostedSubject(root, options);
      await runPostedSubject(root, options);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, route);
      assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), true);
    });
  });
}

test('watcher retries failed notice delivery on an open PR without setting the marker', async () => {
  await withRootAsync(async root => {
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    let attempts = 0;
    const options = { deliverAlertFn: async () => {
      if (++attempts === 1) throw new Error('synthetic bus failure');
    } };
    await runPostedSubject(root, options);
    assert.equal(attempts, 1);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    await runPostedSubject(root, options);
    await runPostedSubject(root, options);
    assert.equal(attempts, 2);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), true);
  });
});

test('watcher live inspection suppresses a notice when the discovered open PR has since closed', async () => {
  await withRootAsync(async root => {
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    const alerts = [];
    await runPostedSubject(root, { liveState: 'CLOSED', deliverAlertFn: async text => alerts.push(text) });
    assert.equal(alerts.length, 0);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
  });
});

test('a non-alerting poll clears the held observation and re-arms the full backstop', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    await maybeDeliverOperatorDecisionNotice(options);
    await maybeDeliverOperatorDecisionNotice({ ...options, decision: { operatorDecisionRequired: false } });
    assert.equal(JSON.parse(readFileSync(noticeStatePath(root), 'utf8')).observation, null);
    await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts.length, 0);
    await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS * 2 });
    assert.equal(alerts.length, 1);
  });
});

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
      if (['pending', 'in-progress'].includes(route)) writeFollowUpJob(join(getFollowUpJobDir(root, route === 'in-progress' ? 'inProgress' : route), 'o__r-pr-1-synthetic.json'), {
        ...identity, status: route, kind: 'adversarial-review-follow-up' });
      for (const now of route === 'eligible' ? [0, 44 * 60_000] : [0, 44 * 60_000, 60 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...options, now,
        reviewRow: { review_status: 'pending' } });
      assert.equal(alerts.length, 0);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /notice held/);
      assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    });
  });
}

for (const reason of ['no-route', 'retry-cap', 'non-retryable: failed-without-merge', 'backstop']) {
  test(`notice delivers once for ${reason} with its reason in the page`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      if (reason === 'no-route') recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
      if (reason === 'retry-cap') recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true, reason: 'hammer-retry-cap' });
      if (reason === 'non-retryable: failed-without-merge') fixtureJSON(amaCloserDispatchFilePath(root, identity), {
        ...identity, state: 'dispatched', workerClass: 'hammer', launchRequestId: 'synthetic-launch', lastObservedStatus: 'failed', outcome: 'failed-without-merge', lastError: 'synthetic-stop' });
      if (reason === 'backstop') {
        await maybeDeliverOperatorDecisionNotice(options);
        await maybeDeliverOperatorDecisionNotice({ ...options, now: 44 * 60_000 });
        assert.equal(alerts.length, 0);
      }
      await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
      await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS + 1 });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, reason);
      if (reason === 'non-retryable: failed-without-merge') assert.equal(alerts[0].meta.payload.hammer_stop_reason, 'synthetic-stop');
      assert.equal(alerts[0].text, 'Adversarial review needs an operator decision for o/r#1: success (remediation-stopped). Reason: ' + reason + '. Findings are unresolved and no closer route is currently making progress. Inspect the closure outcome and restore a closer route or resolve the blockers.');
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
    assert.equal(alerts[0].meta.payload.reason, 'backstop');
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

for (const owner of ['hammer', 'conflict-rebase']) {
  for (const outcome of [{ closureOwner: { owner } }, { closureOwner: { owner }, needsOperator: true },
    { closureOwner: { owner }, reason: 'dispatch-retry-exhausted' }, { closureOwner: { owner: 'page' } }]) {
    test(`terminal launch retains latest route: ${JSON.stringify(outcome)}`, async () => {
      await withRootAsync(async root => {
        const { alerts, logs, options } = noticeFixture(root);
        fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
          launchRequestId: 'synthetic-launch', state: 'dispatched', lastObservedStatus: 'failed', outcome: 'failed-without-merge' });
        recordOperatorNoticeCloserOutcome(root, identity, outcome);
        await maybeDeliverOperatorDecisionNotice(options);
        const operator = outcome.needsOperator || outcome.reason || outcome.closureOwner.owner === 'page';
        assert.equal(alerts.length, operator ? 1 : 0);
        if (!operator) {
          assert.match(logs[0], /closer-route-available/);
          await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
          assert.equal(alerts.length, 1);
          assert.equal(alerts[0].meta.payload.reason, 'backstop');
        }
      });
    });
  }
}

for (const stop of [
  { outcome: 'superseded', stopReason: 'head-changed', backgroundDispatch: { state: 'queued' } },
  { outcome: 'deferred', stopReason: 'github-gate-read-failed: HTTP 401 expired credential' },
  { outcome: 'failed-without-merge', stopReason: 'history-read-failed', retryAfterMs: 30_000 },
]) {
  test(`retryable ${stop.stopReason} keeps the closer route without paging`, async () => {
    await withRootAsync(async root => {
      const { alerts, logs, options } = noticeFixture(root);
      fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
        launchRequestId: 'synthetic-stopped-launch', state: 'launch-terminal',
        lastObservedStatus: 'failed', outcome: stop.outcome, stopReason: stop.stopReason });
      recordOperatorNoticeCloserOutcome(root, identity, { dispatched: false,
        closureOwner: { owner: 'hammer' }, backgroundDispatch: stop.backgroundDispatch,
        retryAfterMs: stop.retryAfterMs });
      const polls = stop.backgroundDispatch || stop.retryAfterMs ? [0, 55 * 60_000, 180 * 60_000] : [0, 44 * 60_000];
      for (const now of polls) await maybeDeliverOperatorDecisionNotice({ ...options, now });
      assert.equal(alerts.length, 0);
      assert.match(logs[0], /closer-route-available/);
    });
  });
}

for (const lifetime of [false, true]) {
  test(`recorded ${lifetime ? 'lifetime' : 'series'} retry cap pages with retry-cap`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      markHammerRetryCapExhausted(root, identity, { jobKey: HEAD, headSha: HEAD,
        attemptCount: lifetime ? 6 : 2, lifetime });
      fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
        launchRequestId: 'synthetic-stopped-launch', state: 'launch-terminal',
        lastObservedStatus: 'failed', outcome: 'deferred', reviewedSha: HEAD });
      recordOperatorNoticeCloserOutcome(root, identity, { closureOwner: { owner: 'hammer' } });
      await maybeDeliverOperatorDecisionNotice(options);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, 'retry-cap');
      assert.match(alerts[0].text, /Reason: retry-cap/);
    });
  });
}

for (const reason of ['hammer-retry-cap-exhausted', 'hammer-lifetime-ceiling-reached',
  'hammer-target-redrive-cap-exhausted']) {
  test(`closer result ${reason} names retry-cap even without a readable ledger`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true, reason });
      await maybeDeliverOperatorDecisionNotice(options);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, 'retry-cap');
    });
  });
}

for (const status of ['requested', 'admitted', 'leased', 'starting', 'running']) {
  test(`55-minute ${status} hammer on another head holds even an operator outcome at multiplier 1`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      const launchHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      fixtureJSON(amaCloserDispatchFilePath(root, { ...identity, headSha: launchHead }), {
        ...identity, headSha: launchHead, workerClass: 'hammer', launchRequestId: 'synthetic-live-launch',
        state: 'dispatched', lastObservedStatus: 'running', dispatchedAt: new Date(0).toISOString(),
        lastObservedAt: new Date(0).toISOString() });
      fixtureJSON(amaCloserLeaseFilePath(root, identity), { ...identity, status: 'terminal', terminalOutcome: 'superseded' });
      recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
      const readLaunchRequestStatusImpl = async args => {
        assert.equal(args.launchRequestId, 'synthetic-live-launch');
        assert.equal(args.includeRetryChain, true);
        return { ok: true, row: { status } };
      };
      for (const now of [0, 55 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...options, now,
        readLaunchRequestStatusImpl });
      assert.equal(alerts.length, 0);
    });
  });
}

test('a live retry descendant holds a terminal ancestor dispatch beyond the backstop', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
      launchRequestId: 'synthetic-ancestor', state: 'launch-terminal',
      lastObservedStatus: 'failed', outcome: 'failed-without-merge' });
    recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
    await maybeDeliverOperatorDecisionNotice({ ...options, now: 55 * 60_000,
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'failed' },
        retryChain: [{ launch_request_id: 'synthetic-retry', status: 'leased' }] }) });
    assert.equal(alerts.length, 0);
  });
});

test('an unreadable retry chain cannot retire a terminal ancestor whose retry may be live', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
      launchRequestId: 'synthetic-ancestor', state: 'launch-terminal',
      lastObservedStatus: 'failed', outcome: 'failed-without-merge' });
    await maybeDeliverOperatorDecisionNotice({ ...options, now: 55 * 60_000,
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'failed' },
        retryChainUnreadable: true }) });
    assert.equal(alerts.length, 0);
  });
});

for (const multiplier of [2, 6]) {
  test(`idle hammer route pages only after the ${multiplier}x load-aware backstop`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      const timeoutOptions = { enabled: true, maxMultiplier: multiplier,
        loadAvg1m: 3, cpuCount: 1, cpuBusyPercent: 85 };
      recordOperatorNoticeCloserOutcome(root, identity, { closureOwner: { owner: 'hammer' } });
      for (const now of [0, 55 * 60_000, OPERATOR_DECISION_NOTICE_BACKSTOP_MS * multiplier - 1]) {
        await maybeDeliverOperatorDecisionNotice({ ...options, now, timeoutOptions });
      }
      assert.equal(alerts.length, 0);
      await maybeDeliverOperatorDecisionNotice({ ...options, timeoutOptions,
        now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS * multiplier,
        readLivePR: async () => ({ state: 'OPEN', headRefOid: HEAD }) });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].meta.payload.reason, 'backstop');
      assert.match(alerts[0].text, /Reason: backstop/);
    });
  });
}

test('a busy hammer earns a fresh idle backstop after it ends', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
      launchRequestId: 'synthetic-launch', state: 'dispatched', lastObservedStatus: 'running' });
    recordOperatorNoticeCloserOutcome(root, identity, { closureOwner: { owner: 'hammer' } });
    for (const now of [0, 55 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...options, now,
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'running' } }) });
    const stopped = { ...options,
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) };
    for (const now of [56 * 60_000, 100 * 60_000]) await maybeDeliverOperatorDecisionNotice({ ...stopped, now });
    assert.equal(alerts.length, 0);
    await maybeDeliverOperatorDecisionNotice({ ...stopped, now: 101 * 60_000 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.payload.reason, 'backstop');
  });
});

test('a failed process without a recorded terminal outcome waits for the backstop', async () => {
  await withRootAsync(async root => {
    const { alerts, options } = noticeFixture(root);
    fixtureJSON(amaCloserDispatchFilePath(root, identity), { ...identity, workerClass: 'hammer',
      launchRequestId: 'synthetic-launch', state: 'launch-terminal', lastObservedStatus: 'failed' });
    await maybeDeliverOperatorDecisionNotice(options);
    assert.equal(alerts.length, 0);
    await maybeDeliverOperatorDecisionNotice({ ...options, now: OPERATOR_DECISION_NOTICE_BACKSTOP_MS });
    assert.equal(alerts[0].meta.payload.reason, 'backstop');
  });
});

for (const pending of ['dispatching', 'queued', 'eligible']) {
  test(`a ${pending} replacement appearing during the live PR lookup prevents delivery`, async () => {
    await withRootAsync(async root => {
      const { alerts, options } = noticeFixture(root);
      recordOperatorNoticeCloserOutcome(root, identity, { needsOperator: true });
      await maybeDeliverOperatorDecisionNotice({ ...options, readLivePR: async () => {
        if (pending === 'dispatching') fixtureJSON(amaCloserDispatchFilePath(root, identity), {
          ...identity, state: 'dispatching', lastAttemptedAt: new Date(0).toISOString() });
        else recordOperatorNoticeCloserOutcome(root, identity, {
          ...(pending === 'queued' ? { backgroundDispatch: { state: 'queued' } } : {}),
          closureOwner: { owner: 'hammer' } });
        return { state: 'OPEN', headRefOid: HEAD };
      } });
      assert.equal(alerts.length, 0);
      assert.equal(hasOperatorDecisionRequiredAlerted(root, identity), false);
    });
  });
}
