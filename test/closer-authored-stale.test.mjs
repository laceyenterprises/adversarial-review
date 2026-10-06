// STALECLOSER-03: one eligibility rule for closer-authored stale heads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLOSER_AUTHORED_STALE_DECISIONS,
  closerAuthoredStaleAuditPath,
  closerAuthoredStaleEligible,
  proveCloserAuthoredStaleHead,
  writeCloserAuthoredStaleAudit,
} from '../src/closer-authored-stale.mjs';
import {
  evaluateHammerRetryCap,
  grantTransientHammerRetry,
  HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const R = 'r'.repeat(40);
const P = 'p'.repeat(40);
const W = 'w'.repeat(40);
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);
const M = 'm'.repeat(40);

// graph: head -> { parent, closer, parentCount }
function graphStubs(graph) {
  const probed = [];
  return {
    probed,
    suppressionImpl: async ({ headSha }) => {
      probed.push(headSha);
      return graph[headSha]?.closer
        ? { suppressed: true, reason: 'closer-commit-trailer' }
        : { suppressed: false, reason: 'no-closer-trailer' };
    },
    fetchCommitImpl: async ({ headSha }) => (graph[headSha]
      ? { sha: headSha, parentSha: graph[headSha].parent, parentCount: graph[headSha].parentCount ?? 1 }
      : null),
  };
}

const CLEAN = { verdict: 'settled-success', blockingFindingState: 'known', blockingFindingCount: 0 };

async function decide(graph, { currentHead, anchorHeads = [], checksConclusion = 'SUCCESS', mergeability = 'MERGEABLE', review = CLEAN } = {}) {
  const headProof = await proveCloserAuthoredStaleHead({ reviewedHead: R, currentHead, anchorHeads, ...graphStubs(graph) });
  return { headProof, eligibility: closerAuthoredStaleEligible({ headProof, ...review, checksConclusion, mergeability }) };
}

test('postmortem 1: closer-only commits after a clean reviewed head with green exact-head CI are eligible', async () => {
  const graph = { [C1]: { parent: R, closer: true }, [C2]: { parent: C1, closer: true } };
  const { headProof, eligibility } = await decide(graph, { currentHead: C2 });
  assert.equal(headProof.proven, true);
  assert.equal(headProof.anchorHead, R);
  assert.deepEqual(headProof.closerCommits, [C2, C1]);
  assert.equal(eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.ELIGIBLE);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.carryForward, true);
  assert.equal(eligibility.currentHead, C2);
  assert.equal(eligibility.reviewedHead, R);
});

test('postmortem 2: any non-closer commit after the reviewed head routes to exact-head re-review', async () => {
  // agent-os#7801 shape: a rebased worker commit sits under the hammer commit.
  const graph = { [W]: { parent: R, closer: false }, [C1]: { parent: W, closer: true } };
  const { headProof, eligibility } = await decide(graph, { currentHead: C1 });
  assert.equal(headProof.proven, false);
  assert.equal(headProof.reason, 'non-closer-commit-after-reviewed-head');
  assert.equal(headProof.nonCloserCommit, W);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
  // A plain worker push on top of the reviewed head is the same answer.
  const pushed = await decide({ [W]: { parent: R, closer: false } }, { currentHead: W });
  assert.equal(pushed.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
});

test('postmortem 3: red exact-head CI is not eligible', async () => {
  const graph = { [C1]: { parent: R, closer: true } };
  for (const checksConclusion of ['FAILURE', 'ERROR', null]) {
    const { eligibility } = await decide(graph, { currentHead: C1, checksConclusion });
    assert.equal(eligibility.eligible, false, String(checksConclusion));
    assert.equal(eligibility.transient, false);
    assert.equal(eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_ELIGIBLE);
    assert.deepEqual(eligibility.reasons, [checksConclusion ? 'ci-not-green' : 'ci-unknown']);
    // The clean reviewed verdict is still carried; CI only decides when to act.
    assert.equal(eligibility.carryForward, true);
  }
});

test('closer commit stacked on a recorded comment-only final-round push anchors at that push', async () => {
  // agent-os#7818/#7822 shape: R reviewed, worker pushed comment-only P, hammer stacked C1 on P.
  const graph = { [P]: { parent: R, closer: false }, [C1]: { parent: P, closer: true } };
  const anchored = await decide(graph, { currentHead: C1, anchorHeads: [P] });
  assert.equal(anchored.headProof.proven, true);
  assert.equal(anchored.headProof.anchorHead, P);
  assert.equal(anchored.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.ELIGIBLE);
  // Without the recorded push, P is a non-closer commit.
  const unanchored = await decide(graph, { currentHead: C1 });
  assert.equal(unanchored.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
});

test('transient misses (CI pending, mergeability UNKNOWN) retry; never a stop', async () => {
  const graph = { [C1]: { parent: R, closer: true } };
  const pending = await decide(graph, { currentHead: C1, checksConclusion: 'PENDING' });
  assert.equal(pending.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.RETRY);
  assert.equal(pending.eligibility.transient, true);
  assert.deepEqual(pending.eligibility.reasons, ['ci-pending']);
  for (const mergeability of ['UNKNOWN', '', null]) {
    const unknown = await decide(graph, { currentHead: C1, mergeability });
    assert.equal(unknown.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.RETRY);
    assert.deepEqual(unknown.eligibility.reasons, ['pr-mergeability-unknown']);
  }
  // A transient miss beside a hard one is a hard miss.
  const redUnknown = await decide(graph, { currentHead: C1, checksConclusion: 'FAILURE', mergeability: 'UNKNOWN' });
  assert.equal(redUnknown.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_ELIGIBLE);
});

test('resolved non-mergeable heads are hard misses even with green exact-head CI', async () => {
  const graph = { [C1]: { parent: R, closer: true } };
  for (const mergeability of ['CONFLICTING', ' conflicting ', 'UNEXPECTED']) {
    const { eligibility } = await decide(graph, { currentHead: C1, mergeability });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.transient, false);
    assert.equal(eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_ELIGIBLE);
    assert.deepEqual(eligibility.reasons, ['pr-not-mergeable']);
    assert.equal(eligibility.carryForward, true);
  }
  const pending = await decide(graph, { currentHead: C1, mergeability: 'CONFLICTING', checksConclusion: 'PENDING' });
  assert.equal(pending.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_ELIGIBLE);
  assert.equal(pending.eligibility.transient, false);
});

test('blocking, unknown-blocking and unsettled verdicts are not carried forward', async () => {
  const graph = { [C1]: { parent: R, closer: true } };
  for (const [review, reason] of [
    [{ ...CLEAN, blockingFindingCount: 1, blockingFindingState: 'present' }, 'blocking-findings-present'],
    [{ ...CLEAN, blockingFindingState: 'unknown', blockingFindingCount: null }, 'blocking-findings-unknown'],
    [{ ...CLEAN, verdict: 'request-changes' }, 'verdict-not-settled-success'],
  ]) {
    const { eligibility } = await decide(graph, { currentHead: C1, review });
    assert.equal(eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_ELIGIBLE, reason);
    assert.equal(eligibility.carryForward, false);
    assert.ok(eligibility.reasons.includes(reason));
  }
});

test('merge commits, broken and over-long chains are never closer-authored', async () => {
  const merge = await decide({ [M]: { parent: R, closer: true, parentCount: 2 } }, { currentHead: M });
  assert.equal(merge.headProof.reason, 'merge-commit-in-closer-chain');
  assert.equal(merge.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
  const broken = await decide({ [C1]: { parent: null, closer: true } }, { currentHead: C1 });
  assert.equal(broken.headProof.reason, 'closer-chain-broken');
  const chain = {};
  let parent = R;
  for (let i = 0; i < 10; i += 1) {
    const head = String(i).repeat(40);
    chain[head] = { parent, closer: true };
    parent = head;
  }
  const long = await decide(chain, { currentHead: parent });
  assert.equal(long.headProof.reason, 'closer-chain-too-long');
  assert.equal(long.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
});

test('a head that is not stale is not-applicable, and probe errors propagate', async () => {
  const same = await decide({}, { currentHead: R });
  assert.equal(same.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_APPLICABLE);
  const reviewed = closerAuthoredStaleEligible({ headProof: { proven: false, reason: 'closer-head-reviewed' }, ...CLEAN,
    checksConclusion: 'SUCCESS', mergeability: 'MERGEABLE' });
  assert.equal(reviewed.decision, CLOSER_AUTHORED_STALE_DECISIONS.NOT_APPLICABLE);
  await assert.rejects(proveCloserAuthoredStaleHead({ reviewedHead: R, currentHead: C1,
    suppressionImpl: async () => { throw new Error('gh down'); } }), /gh down/);
  assert.equal(closerAuthoredStaleEligible({}).decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
});

test('carried-forward verdict is audited once per closer head', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-authored-stale-audit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { eligibility } = await decide({ [C1]: { parent: R, closer: true } }, { currentHead: C1 });
  const logger = { log() {}, warn() {} };
  const args = { repo: 'acme/repo', prNumber: 12, eligibility, verdict: 'comment-only',
    blockingFindingCount: 0, nonBlockingFindingCount: 2, observedAt: '2026-10-05T00:00:00Z', logger };
  const first = writeCloserAuthoredStaleAudit(rootDir, args);
  assert.equal(first.written, true);
  const path = closerAuthoredStaleAuditPath(rootDir, { repo: 'acme/repo', prNumber: 12, headSha: C1 });
  const audit = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(audit.event, 'closer_authored_stale_verdict_carried_forward');
  assert.equal(audit.headSha, C1);
  assert.equal(audit.reviewedHead, R);
  assert.deepEqual(audit.closerCommits, [C1]);
  assert.equal(audit.carriedVerdict, 'comment-only');
  assert.equal(audit.nonBlockingFindingCount, 2);
  assert.deepEqual(writeCloserAuthoredStaleAudit(rootDir, args), { written: false, reason: 'already-audited', path });
  const notEligible = writeCloserAuthoredStaleAudit(rootDir, { ...args, eligibility: { ...eligibility, eligible: false } });
  assert.equal(notEligible.written, false);
  assert.equal(existsSync(path), true);
});

const IDENTITY = { repo: 'acme/repo', prNumber: 12 };

function exhaustSeries(rootDir, head = C1) {
  for (let i = 0; i < 2; i += 1) {
    recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: R, headSha: head, now: `2026-10-05T00:0${i}:00Z` });
  }
}

test('transient hammer retry is granted once per HEAD, not per PR', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-authored-stale-grant-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  exhaustSeries(rootDir);
  const evaluate = (head) => evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, IDENTITY), { jobKey: R, headSha: head });
  assert.equal(evaluate(C1).capExhausted, true);

  const granted = grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: C1, now: '2026-10-05T01:00:00Z' });
  assert.deepEqual(granted, { granted: true, reason: 'closer-authored-stale-transient-retry', headGrants: 1 });
  assert.equal(evaluate(C1).capExhausted, false);
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  assert.deepEqual(ledger.transientRetryHeads, { [C1]: 1 });
  assert.equal(ledger.lastTransientRetryAt, '2026-10-05T01:00:00Z');

  // The re-armed hammer runs and is recorded; the grant survives the record.
  recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: R, headSha: C1, now: '2026-10-05T01:01:00Z' });
  assert.deepEqual(readHammerRetryCapLedger(rootDir, IDENTITY).transientRetryHeads, { [C1]: 1 });
  assert.equal(readHammerRetryCapLedger(rootDir, IDENTITY).lastTransientRetryAt, '2026-10-05T01:00:00Z');
  markHammerRetryCapExhausted(rootDir, IDENTITY, { jobKey: R, headSha: C1, now: '2026-10-05T01:02:00Z' });
  assert.equal(readHammerRetryCapLedger(rootDir, IDENTITY).lastTransientRetryAt, '2026-10-05T01:00:00Z');
  assert.equal(evaluate(C1).capExhausted, true);
  const again = grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: C1 });
  assert.deepEqual(again, { granted: false, reason: 'transient-retry-head-exhausted', headGrants: 1 });

  // A NEW closer head gets its own grant.
  const nextHead = grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: C2 });
  assert.equal(nextHead.granted, true);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, IDENTITY).transientRetryHeads, { [C1]: 1, [C2]: 1 });
});

test('spent transient grants survive more than ten heads and fresh-review resets', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-authored-stale-grant-churn-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  exhaustSeries(rootDir);
  const lifetimeDispatchCeiling = 20;
  const heads = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(40, '0'));
  for (const headSha of heads) {
    const options = { jobKey: R, headSha, lifetimeDispatchCeiling };
    assert.equal(grantTransientHammerRetry(rootDir, IDENTITY, options).granted, true);
    recordHammerRetryDispatch(rootDir, IDENTITY, options);
  }
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  assert.equal(Object.keys(ledger.transientRetryHeads).length, 11);
  assert.equal(ledger.lifetimeAttemptCount, 13);
  const revisit = { jobKey: R, headSha: heads[0], lifetimeDispatchCeiling };
  assert.deepEqual(grantTransientHammerRetry(rootDir, IDENTITY, revisit), {
    granted: false, reason: 'transient-retry-head-exhausted', headGrants: 1,
  });
  for (let i = 0; i < 2; i += 1) {
    recordHammerRetryDispatch(rootDir, IDENTITY, { ...revisit, jobKey: W });
  }
  assert.deepEqual(grantTransientHammerRetry(rootDir, IDENTITY, { ...revisit, jobKey: W }), {
    granted: false, reason: 'transient-retry-head-exhausted', headGrants: 1,
  });
});

test('transient hammer retry never re-opens the lifetime ceiling or a different series', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-authored-stale-grant-lifetime-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  assert.equal(grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: C1 }).reason, 'no-ledger');
  recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: R, headSha: C1 });
  assert.equal(grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: C1 }).reason, 'cap-not-exhausted');
  assert.equal(grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: 'other-review', headSha: C1 }).reason, 'series-changed');
  assert.equal(grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: R, headSha: '' }).reason, 'no-head');
  for (let i = 1; i <= HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES; i += 1) {
    recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: `${R}-${i}`, headSha: `head-${i}` });
  }
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  const lifetime = grantTransientHammerRetry(rootDir, IDENTITY, { jobKey: ledger.jobKey, headSha: 'head-final' });
  assert.equal(lifetime.granted, false);
  assert.equal(lifetime.reason, 'lifetime-ceiling-reached');
});
