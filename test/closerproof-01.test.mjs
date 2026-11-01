import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/rate-limit-state-isolation.mjs';
// CLOSERPROOF-01: the hammer retry-cap series follows the heads the closer
// authored, as the shared attestation proof defines them. A non-closer head
// (for example a rebase of the hammer's commit by another worker) gets the
// normal series budget; a closer push on the same attested chain does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import {
  evaluateHammerRetryCap,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  resetHammerSeriesForNonCloserHead,
} from '../src/ama/hammer-retry-cap.mjs';

const REVIEWED = 'a'.repeat(40);
const HAMMER_1 = 'b'.repeat(40);
const HAMMER_2 = 'c'.repeat(40);
const REBASED = 'e'.repeat(40);
const HAMMER_ON_REBASED = 'f'.repeat(40);
const IDENTITY = { repo: 'fixture/repo', prNumber: 7 };

const edge = (base, head) => ({ author: 'hammer-worker', body: `HAM-Base-Head: ${base}\nHAM-Pushed-Head: ${head}` });
// The rebased head carries the hammer's commit trailers, but trailers are never read.
const COMMENTS = [edge(REVIEWED, HAMMER_1), edge(HAMMER_1, HAMMER_2)];

function prove(currentHead, comments = COMMENTS) {
  return proveCloserAuthoredStaleHead({ reviewedHead: REVIEWED, currentHead, comments });
}

function exhaustedLedger(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerproof-01-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (let i = 0; i < 2; i += 1) {
    recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: REVIEWED, headSha: REVIEWED,
      launchRequestId: `lrq_fixture_${i}`, now: `2026-11-01T00:0${i}:00Z` });
  }
  markHammerRetryCapExhausted(rootDir, IDENTITY, { jobKey: REVIEWED, headSha: REVIEWED, attemptCount: 2,
    alertEmitted: true, now: '2026-11-01T00:05:00Z' });
  return rootDir;
}

const evaluate = (rootDir, headSha) => evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, IDENTITY), {
  jobKey: REVIEWED, headSha,
});

test('the shared proof reports whether an authenticated hammer edge ends at the exact head', async () => {
  const rebased = await prove(REBASED);
  assert.equal(rebased.proven, false);
  assert.equal(rebased.reason, 'hammer-app-attestation-missing');
  assert.equal(rebased.currentHeadHammerAttested, false);

  const hammer = await prove(HAMMER_2);
  assert.equal(hammer.proven, true);
  assert.equal(hammer.currentHeadHammerAttested, true);

  // A hammer push based on a non-closer head is attested even though the chain
  // from the reviewed head is broken.
  const onRebased = await prove(HAMMER_ON_REBASED, [...COMMENTS, edge(REBASED, HAMMER_ON_REBASED)]);
  assert.equal(onRebased.proven, false);
  assert.equal(onRebased.currentHeadHammerAttested, true);

  // Hex case is not identity: an uppercase edge head still attests the head.
  const upper = await prove(REBASED, [...COMMENTS, edge(HAMMER_2, REBASED.toUpperCase())]);
  assert.equal(upper.currentHeadHammerAttested, true);

  // No comment read: unknown, never false.
  const unread = await proveCloserAuthoredStaleHead({ reviewedHead: REVIEWED, currentHead: REBASED });
  assert.equal(unread.currentHeadHammerAttested, undefined);
});

test('a retry cap exhausted on head A gives a non-closer head B the normal series budget', async t => {
  const rootDir = exhaustedLedger(t);
  const before = evaluate(rootDir, REBASED);
  assert.equal(before.capExhausted, true);
  const lifetimeBefore = before.priorLifetimeCount;

  const result = resetHammerSeriesForNonCloserHead(rootDir, IDENTITY, {
    jobKey: REVIEWED, headSha: REBASED, headProof: await prove(REBASED), now: '2026-11-01T01:00:00Z',
  });
  assert.equal(result.reset, true);
  assert.equal(result.receipt.priorAttemptCount, 2);
  assert.equal(result.receipt.priorSuppressed, true);

  const after = evaluate(rootDir, REBASED);
  assert.equal(after.capExhausted, false);
  assert.equal(after.alreadySuppressed, false);
  assert.equal(after.nextAttemptCount, 1);
  // The per-PR lifetime ceiling is unchanged.
  assert.equal(after.priorLifetimeCount, lifetimeBefore);
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  assert.equal(ledger.lifetimeAttemptCount, 2);
  assert.equal(ledger.jobKey, REVIEWED);

  // One reset per head, and the receipt survives the next dispatch record.
  assert.equal(resetHammerSeriesForNonCloserHead(rootDir, IDENTITY, {
    jobKey: REVIEWED, headSha: REBASED, headProof: await prove(REBASED) }).reason, 'already-reset');
  recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: REVIEWED, headSha: REBASED,
    launchRequestId: 'lrq_fixture_b', now: '2026-11-01T01:05:00Z' });
  assert.ok(readHammerRetryCapLedger(rootDir, IDENTITY).nonCloserHeadResets[REBASED]);
  assert.equal(evaluate(rootDir, REBASED).nextAttemptCount, 2);
  assert.equal(evaluate(rootDir, REBASED).capExhausted, false);

  // The hammer's own push on top of B does not reset again.
  const hammerPush = await prove(HAMMER_ON_REBASED, [...COMMENTS, edge(REBASED, HAMMER_ON_REBASED)]);
  assert.equal(resetHammerSeriesForNonCloserHead(rootDir, IDENTITY, {
    jobKey: REVIEWED, headSha: HAMMER_ON_REBASED, headProof: hammerPush }).reset, false);
});

test('a hammer re-push on the same attested chain leaves the cap unchanged', async t => {
  const rootDir = exhaustedLedger(t);
  const before = readHammerRetryCapLedger(rootDir, IDENTITY);
  const result = resetHammerSeriesForNonCloserHead(rootDir, IDENTITY, {
    jobKey: REVIEWED, headSha: HAMMER_2, headProof: await prove(HAMMER_2),
  });
  assert.deepEqual(result, { reset: false, reason: 'closer-authorship-not-disproven' });
  assert.deepEqual(readHammerRetryCapLedger(rootDir, IDENTITY), before);
  assert.equal(evaluate(rootDir, HAMMER_2).capExhausted, true);
});

test('unknown, mis-anchored or lifetime-exhausted cases never reset the series', async t => {
  const rootDir = exhaustedLedger(t);
  const proof = await prove(REBASED);
  const attempt = overrides => resetHammerSeriesForNonCloserHead(rootDir, IDENTITY, {
    jobKey: REVIEWED, headSha: REBASED, headProof: proof, ...overrides }).reason;
  assert.equal(attempt({ headProof: { ...proof, currentHeadHammerAttested: undefined } }),
    'closer-authorship-not-disproven');
  assert.equal(attempt({ headProof: { ...proof, reason: 'closer-proof-failed' } }), 'closer-authorship-not-disproven');
  assert.equal(attempt({ headSha: HAMMER_1 }), 'closer-authorship-not-disproven');
  assert.equal(attempt({ jobKey: HAMMER_1 }), 'closer-authorship-not-disproven');
  assert.equal(attempt({ headSha: REVIEWED, headProof: { ...proof, currentHead: REVIEWED } }), 'closer-dispatched-head');
  assert.equal(evaluate(rootDir, REBASED).capExhausted, true);

  const lifetimeRoot = mkdtempSync(join(tmpdir(), 'closerproof-01-lifetime-'));
  t.after(() => rmSync(lifetimeRoot, { recursive: true, force: true }));
  recordHammerRetryDispatch(lifetimeRoot, IDENTITY, { jobKey: REVIEWED, headSha: REVIEWED, launchRequestId: 'lrq_l' });
  markHammerRetryCapExhausted(lifetimeRoot, IDENTITY, { jobKey: REVIEWED, headSha: REVIEWED, lifetime: true });
  assert.equal(resetHammerSeriesForNonCloserHead(lifetimeRoot, IDENTITY, {
    jobKey: REVIEWED, headSha: REBASED, headProof: proof }).reason, 'lifetime-suppressed');
  assert.equal(evaluate(lifetimeRoot, REBASED).lifetimeCapExhausted, true);
});

// The closure orchestration applies the reset with the same proof it used to
// decide closer authorship, before the owner cap is evaluated.
async function orchestrate(t, headSha, headProof) {
  const rootDir = exhaustedLedger(t);
  const body = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- Synthetic finding\n\n## Verdict\nComment only';
  const quiet = { log() {}, warn() {}, error() {} };
  await maybeDispatchAmaClosureFor({ rootDir, repoPath: IDENTITY.repo, prNumber: IDENTITY.prNumber,
    currentRevisionRef: headSha, labelNames: [], dispatchJob: { remediationStopCode: 'max-rounds-reached' },
    reviewStateRow: { repo: IDENTITY.repo, pr_number: IDENTITY.prNumber, pr_state: 'open', review_status: 'posted',
      reviewer: 'codex', reviewer_head_sha: REVIEWED, review_body: body, posted_at: '2026-11-01T00:00:00.000Z' },
    candidate: { headSha, prState: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    now: () => Date.parse('2026-11-01T02:00:00.000Z'), logger: quiet,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    proveCloserAuthoredStaleHeadImpl: async () => headProof,
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    observeClosureWaitImpl: async () => ({ exhausted: true, retryAfterMs: 30_000 }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken' }),
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, reason: 'fixture-closer' }),
  });
  return rootDir;
}

test('the closure pass resets the series for a non-closer head and leaves an attested head alone', async t => {
  const rebasedRoot = await orchestrate(t, REBASED, await prove(REBASED));
  assert.ok(readHammerRetryCapLedger(rebasedRoot, IDENTITY).nonCloserHeadResets?.[REBASED]);
  assert.equal(evaluate(rebasedRoot, REBASED).capExhausted, false);

  const hammerRoot = await orchestrate(t, HAMMER_2, await prove(HAMMER_2));
  assert.equal(readHammerRetryCapLedger(hammerRoot, IDENTITY).nonCloserHeadResets, undefined);
  assert.equal(evaluate(hammerRoot, HAMMER_2).capExhausted, true);
});
