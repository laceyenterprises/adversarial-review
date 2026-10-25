import './helpers/load-aware-timeout-fixture.mjs';
// STALECLOSER-03: one eligibility rule for closer-authored stale heads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    comments: Object.entries(graph).filter(([, edge]) => edge.closer).map(([head, edge]) => ({
      author: 'the-hammer-lacey[bot]', body: `HAM-Base-Head: ${edge.parent}\nHAM-Validated-Head: ${head}`,
    })),
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

function remediationFixture(t, jobOverrides = {}, roundOverrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-round-chain-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'fixture__repo-pr-42-round.json');
  writeFileSync(path, JSON.stringify({ repo: 'fixture/repo', prNumber: 42, status: 'completed',
    remediationPlan: { rounds: [{ state: 'completed', startHeadSha: R, resultingHeadSha: M, ...roundOverrides }] },
    ...jobOverrides }));
  const comments = [[M, C1], [C1, C2], [C2, W]].map(([base, head]) => ({
    author: 'hammer-worker', body: `HAM-Base-Head: ${base}\nHAM-Pushed-Head: ${head}`,
  }));
  return { path, options: { rootDir, repoPath: 'fixture/repo', prNumber: 42,
    reviewedHead: R, currentHead: W, comments } };
}

async function decideRound(options) {
  const headProof = await proveCloserAuthoredStaleHead(options);
  return { headProof, eligibility: closerAuthoredStaleEligible({ headProof, ...CLEAN,
    checksConclusion: 'SUCCESS', mergeability: 'MERGEABLE' }) };
}

test('HAMROUNDEDGE-01 reviewed -> remediated -> three hammer pushes is eligible', async t => {
  const { path, options } = remediationFixture(t);
  const { headProof, eligibility } = await decideRound(options);
  assert.equal(headProof.proven, true);
  assert.equal(headProof.anchorHead, R);
  assert.deepEqual(headProof.closerCommits, [W, C2, C1, M]);
  assert.equal(eligibility.decision, 'eligible');
  assert.equal(eligibility.carryForward, true);
  rmSync(path);
  const missing = await decideRound(options);
  assert.equal(missing.headProof.reason, 'hammer-app-attestation-missing');
  assert.equal(missing.eligibility.decision, 'rereview-exact-head');
});

for (const [name, job, round] of [
  ['incomplete round', {}, { state: 'spawned' }],
  ['missing resulting head', {}, { resultingHeadSha: null }],
  ['unconnected round', {}, { startHeadSha: P }],
  ['different PR', { prNumber: 43 }, {}],
  ['different repo', { repo: 'fixture/other' }, {}],
  ['incomplete job', { status: 'running' }, {}],
]) {
  test(`HAMROUNDEDGE-01 ${name} cannot bridge to the hammer base`, async t => {
    const { options } = remediationFixture(t, job, round);
    const { headProof, eligibility } = await decideRound(options);
    assert.equal(headProof.proven, false);
    assert.equal(eligibility.decision, 'rereview-exact-head');
  });
}

test('HAMROUNDEDGE-01 completed rounds cannot authorize a round-only or builder-authored tip', async t => {
  const { options } = remediationFixture(t);
  for (const overrides of [
    { currentHead: M, comments: [] },
    { currentHead: M }, // Unrelated later hammer edges confer no authority on M.
    { comments: options.comments.map(comment => ({ ...comment, author: 'builder-worker' })) },
    { comments: options.comments.map(comment => ({ ...comment, author: 'remediator-worker' })) },
  ]) {
    const { eligibility } = await decideRound({ ...options, ...overrides });
    assert.equal(eligibility.decision, 'rereview-exact-head');
  }
});

test('HAMROUNDEDGE-01 mixed edges retain the chain-length limit and eligibility gates', async t => {
  const { options } = remediationFixture(t);
  assert.equal((await decideRound({ ...options, maxCommits: 4 })).eligibility.decision, 'eligible');
  assert.equal((await decideRound({ ...options, maxCommits: 3 })).headProof.reason, 'closer-chain-too-long');
  const { headProof } = await decideRound(options);
  for (const [overrides, decision] of [
    [{ checksConclusion: 'PENDING' }, 'retry'],
    [{ checksConclusion: 'FAILURE' }, 'not-eligible'],
    [{ mergeability: 'UNKNOWN' }, 'retry'],
    [{ mergeability: 'CONFLICTING' }, 'not-eligible'],
    [{ blockingFindingState: 'present', blockingFindingCount: 1 }, 'not-eligible'],
    [{ verdict: 'request-changes' }, 'not-eligible'],
  ]) {
    assert.equal(closerAuthoredStaleEligible({ headProof, ...CLEAN,
      checksConclusion: 'SUCCESS', mergeability: 'MERGEABLE', ...overrides }).decision, decision);
  }
});

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
  assert.equal(headProof.reason, 'hammer-app-attestation-missing');

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

test('HAMCLOSE-01 recorded builder/remediator pushes are not trust anchors', async () => {
  // agent-os#7818/#7822 shape: R reviewed, worker pushed comment-only P, hammer stacked C1 on P.
  const graph = { [P]: { parent: R, closer: false }, [C1]: { parent: P, closer: true } };
  const anchored = await decide(graph, { currentHead: C1, anchorHeads: [P] });
  assert.equal(anchored.headProof.proven, false);
  assert.equal(anchored.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.REREVIEW);
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

test('HAMCLOSE-01 App bindings support rebases/merges; broken and over-long bindings request review', async () => {
  const merge = await decide({ [M]: { parent: R, closer: true, parentCount: 2 } }, { currentHead: M });
  assert.equal(merge.headProof.proven, true);
  assert.equal(merge.eligibility.decision, CLOSER_AUTHORED_STALE_DECISIONS.ELIGIBLE);
  const broken = await decide({ [C1]: { parent: null, closer: true } }, { currentHead: C1 });
  assert.equal(broken.headProof.reason, 'hammer-app-attestation-missing');
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
    repoPath: 'fixture/repo', prNumber: 1,
    execGhWithRetryImpl: async () => { throw new Error('gh down'); } }), /gh down/);
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
