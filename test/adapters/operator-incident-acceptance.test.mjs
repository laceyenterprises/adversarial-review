import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinearTriageAdapter } from '../../src/adapters/operator/linear-triage/index.mjs';
import {
  attemptPendingTriageSync,
  listPendingTriageSyncs,
  queuePendingTriageSync,
} from '../../src/pending-triage-sync.mjs';

const chronology = JSON.parse(readFileSync(new URL('../fixtures/incident-acceptance/lac-2089.json', import.meta.url), 'utf8'));

function fixture(t, { title = chronology.issue.title, labels = [], state = 'In Review', stateNames } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'incident-triage-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const states = [
    { id: 'review', name: 'In Review', type: 'started' },
    { id: 'progress', name: 'In Progress', type: 'started' },
    { id: 'done', name: 'Done', type: 'completed' },
    { id: 'cancelled', name: 'Cancelled', type: 'canceled' },
    { id: 'custom-done', name: 'Accepted', type: 'completed' },
  ];
  const updates = [];
  const comments = [];
  const logs = [];
  const errors = [];
  const issue = {
    id: 'native-incident', title,
    team: Promise.resolve({ states: async () => ({ nodes: states }) }),
    state: states.find((s) => s.name === state),
    labels: async () => ({ nodes: labels.map((name) => ({ name })) }),
  };
  const adapter = createLinearTriageAdapter({
    rootDir, env: {}, stateNames,
    linearClientProvider: async () => ({
      issue: async () => issue,
      updateIssue: async (id, payload) => {
        updates.push({ id, ...payload });
        issue.state = states.find((s) => s.id === payload.stateId);
      },
      createComment: async (comment) => comments.push(comment),
    }),
    logger: { log: (message) => logs.push(message), error: (...args) => errors.push(args) },
  });
  const ref = {
    domainId: 'code-pr', subjectExternalId: `${chronology.repo}#${chronology.prNumber}`,
    linearTicketId: chronology.linearTicketId, revisionRef: chronology.review.revisionRef,
    // PR metadata is not the incident authority.
    labels: [],
  };
  return { adapter, ref, issue, updates, comments, logs, errors, rootDir };
}

test('LAC-2092: first comment-only review precedes remediation and cannot accept the incident', async (t) => {
  const { adapter, ref, issue, updates, logs, rootDir } = fixture(t);
  const c = chronology;
  const times = [c.review.createdAt, c.observedDoneAt, c.claimedAt, c.spawnedAt,
    c.publishedHeadCiStartedAt, c.operatorReopenedAt].map(Date.parse);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
  assert.equal(c.openSnapshot, 'OPEN');
  assert.equal(c.review.finalRound, 'comment-only');
  assert.equal(c.review.nonBlockingOnly, true);
  assert.equal(c.nativeReply.nonBlocking.length, 2);
  assert.equal(c.nativeReply.outcome, 'partial');
  assert.equal(c.nativeReply.reReview.requested, false);
  assert.match(c.nativeReply.summary, new RegExp(c.publishedHead));

  // Same production entry point that wrote Done after queuing the review job.
  await adapter.recordReviewCompleted(ref, { reviewBody: c.review.reviewBody });
  assert.equal(issue.state.name, 'In Review');
  assert.deepEqual(updates, []);
  assert.match(logs[0], /incident acceptance owned externally/);

  await adapter.syncTriageStatus(ref, 'remediation-running');
  assert.equal(issue.state.name, 'In Progress');
  ref.revisionRef = c.publishedHead;
  await adapter.syncTriageStatus(ref, 'approved');
  await adapter.recordReviewerEngagement(ref, { completedAt: c.publishedHeadCiStartedAt });
  assert.equal(issue.state.name, 'In Progress');

  // Later source merge and replay of its owed work do not acquire acceptance.
  const record = queuePendingTriageSync(rootDir, {
    repo: c.repo, prNumber: c.prNumber, linearTicketId: c.linearTicketId,
    transition: 'merged', status: 'done', revisionRef: c.publishedHead,
    now: new Date(c.operatorReopenedAt),
  });
  const sync = await attemptPendingTriageSync({ rootDir, record, operatorSurface: adapter, buildSubjectRef: () => ref });
  assert.equal(sync.ok, true);
  assert.deepEqual(listPendingTriageSyncs(rootDir), []);
  await adapter.syncTriageStatus(ref, 'finalized');
  assert.equal(issue.state.name, 'In Progress');
  assert.deepEqual(updates.map((u) => u.stateId), ['progress']);
});

test('incident labels protect renamed tickets and late live metadata changes', async (t) => {
  for (const label of ['incident', 'Incident', 'SEV3', 'sev-2', 'SEV 1']) {
    const f = fixture(t, { title: 'Registry audit lock ordering', labels: [label] });
    for (const status of ['done', 'approved', 'finalized', 'halted', 'cancelled', 'Accepted']) {
      await f.adapter.syncTriageStatus(f.ref, status);
    }
    assert.deepEqual(f.updates, [], label);
  }
  const f = fixture(t, { title: 'Registry audit lock ordering' });
  await f.adapter.syncTriageStatus(f.ref, 'done');
  assert.equal(f.updates.length, 1);
  f.issue.state = { name: 'In Progress', type: 'started' };
  f.issue.labels = async () => ({ nodes: [{ name: 'incident' }] });
  await f.adapter.syncTriageStatus(f.ref, 'done');
  assert.equal(f.updates.length, 1, 'client memoization must not cache issue identity');
});

test('incident terminal ownership survives custom states and stale progress sync', async (t) => {
  const f = fixture(t, { state: 'Accepted', stateNames: { done: 'Accepted' } });
  await f.adapter.syncTriageStatus(f.ref, 'in-review');
  await f.adapter.syncTriageStatus(f.ref, 'in-progress');
  assert.deepEqual(f.updates, []);
  assert.equal(f.issue.state.name, 'Accepted');
  const g = fixture(t, { stateNames: { done: 'In Progress' } });
  // Configured terminal aliases remain guarded even without a completed type.
  await g.adapter.syncTriageStatus(g.ref, 'done');
  assert.deepEqual(g.updates, []);
});

test('incident completion guard retains critical finding comments', async (t) => {
  const f = fixture(t);
  await f.adapter.recordReviewCompleted(f.ref, {
    reviewBody: '## Blocking issues\n- **Unsafe update**\n\n## Verdict\nRequest changes',
  });
  assert.deepEqual(f.updates, []);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /1 blocking finding/);
  const g = fixture(t, { title: 'Registry audit lock ordering' });
  g.issue.labels = async () => { throw new Error('temporary label read failure'); };
  await g.adapter.recordReviewCompleted(g.ref, {
    reviewBody: '## Blocking issues\n- **Unsafe update**\n\n## Verdict\nRequest changes',
  });
  assert.deepEqual(g.updates, []);
  assert.equal(g.errors.length, 1);
  assert.equal(g.comments.length, 1, 'identity-read failure cannot hide critical findings');
});

test('unreadable or incomplete incident metadata cannot authorize terminal sync', async (t) => {
  for (const labels of [
    async () => { throw new Error('Linear unavailable'); },
    async () => null,
    async () => ({ nodes: [], pageInfo: { hasNextPage: true } }),
  ]) {
    const f = fixture(t, { title: 'Registry audit lock ordering' });
    f.issue.labels = labels;
    await assert.rejects(f.adapter.syncTriageStatus(f.ref, 'done'), /incident identity unavailable/);
    assert.deepEqual(f.updates, []);
    assert.equal(f.errors.length, 1);
    f.issue.labels = async () => ({ nodes: [] });
    await f.adapter.syncTriageStatus(f.ref, 'done');
    assert.equal(f.updates.length, 1, 'later successful reads retain ordinary convergence');
  }
});

test('identity read failures retain owed triage work until a successful retry', async (t) => {
  const f = fixture(t, { title: 'Improve review routing' });
  const record = queuePendingTriageSync(f.rootDir, {
    repo: chronology.repo, prNumber: chronology.prNumber, transition: 'merged', status: 'done',
  });
  f.issue.labels = async () => { throw new Error('temporary label read failure'); };
  const args = { rootDir: f.rootDir, record, operatorSurface: f.adapter, buildSubjectRef: () => f.ref, logger: {} };
  assert.equal((await attemptPendingTriageSync(args)).ok, false);
  assert.equal(listPendingTriageSyncs(f.rootDir).length, 1);
  assert.deepEqual(f.updates, []);
  f.issue.labels = async () => ({ nodes: [] });
  assert.equal((await attemptPendingTriageSync(args)).ok, true);
  assert.deepEqual(listPendingTriageSyncs(f.rootDir), []);
  assert.equal(f.issue.state.name, 'Done');
});

test('ordinary feature tickets retain review, merge and cancellation synchronization', async (t) => {
  for (const title of ['Improve routing', 'Add SEV3 dashboard filter', 'Incident response documentation']) {
    const f = fixture(t, { title, labels: ['feature', 'severity-dashboard'] });
    await f.adapter.recordReviewCompleted(f.ref, { reviewBody: chronology.review.reviewBody });
    await f.adapter.syncTriageStatus(f.ref, 'in-progress');
    await f.adapter.syncTriageStatus(f.ref, 'finalized');
    await f.adapter.syncTriageStatus(f.ref, 'cancelled');
    assert.deepEqual(f.updates.map((u) => u.stateId), ['done', 'progress', 'done', 'cancelled'], title);
  }
});
