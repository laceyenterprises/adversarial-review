import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { hammerAttestationChain, fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, isHeldAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { classifyCheckRollup } from '../src/checks-summary.mjs';
import { __testables__ as closer, isHammerRemediableEligibilityMiss } from '../src/ama/dispatch-closer.mjs';
import { closerAuthoredStaleEligible, proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';
import { evaluateHammerRetryCap } from '../src/ama/hammer-retry-cap.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';

const reviewed = 'a'.repeat(40), hammer = 'b'.repeat(40), next = 'c'.repeat(40);
const audit = (base, head, author = 'the-hammer-lacey[bot]') => ({
  author, body: `HAM-Base-Head: ${base}\nHAM-Validated-Head: ${head}`,
});
const clean = { verdict: 'approved', headSha: reviewed, riskClass: 'low', remediationPending: false,
  blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };

test('HAMCLOSE-01 git publication and earlier App-attested bases need no signatures or commit identities', async () => {
  for (const base of [reviewed, hammer]) {
    const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: reviewed,
      currentHead: next, hammerBaseHead: base, comments: [audit(reviewed, hammer)],
      get() { throw new Error('App proof must not read commit identities or signatures'); } });
    assert.equal(range.verified, true);
    assert.equal(range.currentHead, next);
    assert.equal(range.proof, 'hammer-app-attestation-chain');
  }
});

test('HAMCLOSE-01 builder pushes and pushes above an attested head require review', async () => {
  const comments = [audit(reviewed, hammer)];
  assert.deepEqual(hammerAttestationChain(comments, reviewed, hammer), [hammer]);
  assert.equal(hammerAttestationChain(comments, reviewed, next), null);
  assert.equal(hammerAttestationChain([...comments, audit(hammer, next, 'builder')], reviewed, next), null);
  assert.equal(hammerAttestationChain([audit(hammer, next), audit(next, hammer)], reviewed, next), null);
  assert.equal(await fetchHammerHeadRange({ reviewedHead: reviewed, currentHead: 'd'.repeat(40),
    hammerBaseHead: next, comments, get() { throw new Error('untrusted base routes directly to review'); } }), null);
  assert.deepEqual(hammerAttestationChain([audit(hammer, next), ...comments], reviewed, next), [hammer, next]);
});

test('HAMCLOSE-01 forged commit fields and a reusable old App audit never grant authority; review takes ownership', async () => {
  const primaryChange = { headSha: hammer, hasHammerCommits: false };
  const body = 'An earlier hammer audit without an exact head binding';
  const verdict = isEligibleForAmaClosure(clean, { headSha: hammer, isOpen: true,
    isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }, {
    enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false },
  }, { primaryChange, hamTerminalRemediation: { active: true, commit: { sha: hammer }, auditComment: { body } },
    hamTerminalRemediationGroundTruth: { commit: { sha: hammer, parentSha: reviewed,
      author: 'hammer-worker', committer: 'hammer-worker', changedFiles: ['src/fixture.mjs'], primaryChange,
      trailers: { 'Worker-Class': 'hammer', 'Worker-Ticket': 'HAM', 'Reviewed-Head': reviewed,
        'Closed-By': 'hammer (adversarial-pipe-mode)' } },
      auditComment: { body, author: 'hammer-worker' },
      range: { verified: true, reviewedHead: reviewed, currentHead: hammer, baseSha: reviewed, commits: [hammer] } } });
  assert.equal(verdict.trace.hamTerminalRemediation.activeAuthorized, false);
  assert.equal(verdict.eligible, false);
  const headProof = await proveCloserAuthoredStaleHead({ reviewedHead: reviewed, currentHead: hammer, comments: [],
    suppressionImpl() { throw new Error('commit trailers are not provenance'); },
    fetchCommitImpl() { throw new Error('commit identity is not provenance'); } });
  assert.equal(headProof.proven, false);
  const recovery = await recoverStrandedCloserHead({ result: { dispatched: false,
    reason: 'not-eligible', reasons: verdict.reasons }, closerAuthored: true, rootDir: '/fixture',
    repo: 'fixture/repo', prNumber: 8139, headSha: hammer, logger: { log() {}, warn() {} },
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    requestBoundedReviewImpl: async () => ({ triggered: true }) });
  assert.equal(recovery.reason, 'closer-head-exact-review-requested');
});

test('HAMCLOSE-01 handed review clean merges; comment-only findings acquire exactly one new hammer', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamclose-lease-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 8134, headSha: reviewed };
  assert.equal(acquireAmaCloserLease(identity).acquired, true);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'finished-hammer' });
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' });
  updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'handed-to-review');
  assert.equal(isHeldAmaCloserLease(rootDir, identity), false);
  const lease = readAmaCloserLease(rootDir, identity);
  assert.equal(decideClosureOwner({ reviewState: clean, currentHead: reviewed, lease }).owner, 'daemon-merge');
  assert.equal(decideClosureOwner({ reviewState: { ...clean, verdict: 'comment-only', nonBlockingFindingCount: 2 },
    currentHead: reviewed, lease }).owner, 'hammer');
  assert.equal(acquireAmaCloserLease({ ...identity, fromReviewHandoff: true }).acquired, true);
  assert.equal(acquireAmaCloserLease({ ...identity, fromReviewHandoff: true }).acquired, false);
});

test('HAMCLOSE-01 concurrent processes cannot both reclaim a handed review lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamclose-concurrent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 8134, headSha: reviewed };
  acquireAmaCloserLease(identity);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'finished-hammer' });
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' });
  const moduleUrl = new URL('../src/ama/closer-lease.mjs', import.meta.url).href;
  const script = `import { acquireAmaCloserLease } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(acquireAmaCloserLease(${JSON.stringify({ ...identity, fromReviewHandoff: true })})));`;
  const execute = promisify(execFile);
  const results = await Promise.all([0, 1].map(() => execute(process.execPath,
    ['--input-type=module', '-e', script], { timeout: 10_000 })));
  assert.equal(results.filter(result => JSON.parse(result.stdout).acquired).length, 1);
});

test('HAMCLOSE-01 lease contention is bounded, retries promptly and pages once naming the PR and reason', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamclose-wait-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const args = { rootDir, repo: 'fixture/repo', prNumber: 8142, headSha: reviewed,
    reason: 'lease-contended', env: { AMA_CLOSURE_WAIT_BOUND_MS: '100' }, pageImpl: async text => pages.push(text) };
  assert.equal((await observeClosureWait({ ...args, now: 0 })).retryAfterMs, 30_000);
  assert.equal((await observeClosureWait({ ...args, now: 99 })).exhausted, false);
  assert.equal((await observeClosureWait({ ...args, now: 100 })).exhausted, true);
  await observeClosureWait({ ...args, now: 101 });
  assert.equal(pages.length, 1);
  assert.match(pages[0], /fixture\/repo PR 8142.*lease-contended/);
});

test('HAMCLOSE-01 a finished hammer worktree removal failure leaves its outcome unchanged', async () => {
  const logs = [];
  const logger = { info() {}, warn: text => logs.push(text), error: text => logs.push(text) };
  const outcome = { outcome: 'handed-to-review', headSha: hammer };
  const cleanup = await closer.cleanupHammerCloserWorker({ prNumber: 8134, workerClass: 'hammer',
    hqPath: '/fixture/hq', hqRoot: '/fixture/root', reason: 'terminal-status-succeeded', logger,
    execFileImpl: async () => { throw new Error('removing git worktree failed'); } });
  assert.equal(cleanup.ok, false);
  assert.doesNotThrow(() => closer.logHammerCleanupFailure(cleanup, {
    logger, repo: 'fixture/repo', prNumber: 8134, phase: 'terminal-status-succeeded',
  }));
  assert.deepEqual(outcome, { outcome: 'handed-to-review', headSha: hammer });
  assert.ok(logs.some(text => text.includes('hammer_worker_cleanup_nonfatal')));
});

function* product(axes, row = []) {
  if (!axes.length) { yield row; return; }
  for (const value of axes[0]) yield* product(axes.slice(1), [...row, value]);
}

test('HAMCLOSE-01 exhaustive open non-held ownership cross product uses real eligibility, checks and ownership decisions', async () => {
  const owners = new Set(['daemon-merge', 'hammer', 'review', 'remediation', 'conflict-rebase', 'wait', 'page']);
  const proofs = Object.fromEntries(await Promise.all(['reviewed', 'untrusted', 'attested'].map(async kind => [kind,
    await proveCloserAuthoredStaleHead({ reviewedHead: reviewed,
      currentHead: kind === 'reviewed' ? reviewed : hammer,
      comments: kind === 'attested' ? [audit(reviewed, hammer)] : [],
    }),
  ])));
  let combinations = 0;
  for (const [verdict, headKind, leaseKind, retryExhausted, lifetimeExhausted, mergeable, conclusion,
    roundsLeft, stuck, retrigger] of product([
    ['', 'approved', 'comment-clean', 'comment-findings', 'request-changes'],
    ['reviewed', 'untrusted', 'attested'], ['none', 'dispatched', 'handed-to-review', 'terminal'],
    [false, true], [false, true], ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    ['SUCCESS', 'FAILURE', 'PENDING'], [true, false], [false, true], [false, true],
  ])) {
    combinations++;
    const currentHead = headKind === 'reviewed' ? reviewed : hammer;
    const attested = headKind === 'attested';
    const reviewState = { ...clean, verdict: verdict.startsWith('comment') ? 'comment-only' : verdict,
      nonBlockingFindingCount: verdict === 'comment-findings' ? 2 : 0,
      blockingFindingCount: verdict === 'request-changes' ? 1 : 0 };
    const labels = [stuck && 'merge-agent-stuck', retrigger && 'retrigger-review'].filter(Boolean);
    const checks = [{ __typename: 'CheckRun', name: 'test',
      status: conclusion === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: conclusion === 'PENDING' ? null : conclusion }];
    const classified = classifyCheckRollup(checks);
    const lease = leaseKind === 'none' ? null : { status: leaseKind, lrqId: 'fixture-run' };
    const cap = evaluateHammerRetryCap({ jobKey: reviewed, attemptCount: retryExhausted ? 2 : 0,
      lifetimeAttemptCount: lifetimeExhausted ? 6 : retryExhausted ? 2 : 0 }, {
      jobKey: reviewed, headSha: currentHead, lifetimeDispatchCeiling: 6,
    });
    assert.equal(cap.capExhausted, retryExhausted || lifetimeExhausted);
    assert.equal(cap.lifetimeCapExhausted, lifetimeExhausted);
    const input = { reviewState, currentHead, attested, lease,
      retryExhausted: cap.capExhausted, lifetimeExhausted: cap.lifetimeCapExhausted,
      mergeable, checks: classified, roundsLeft, labels };
    const result = decideClosureOwner(input);
    const rescue = classifyClosureOwnership(input);
    assert.deepEqual(rescue.closureOwner, result);
    assert.ok(['merge-eligible', 'hammer-eligible', 'rereview-eligible', 'remediation-eligible',
      'rebase-eligible', 'wait-closer', 'page-required'].includes(rescue.decision));
    assert.ok(owners.has(result.owner), JSON.stringify(input));
    assert.ok(result.reason);
    if (result.owner === 'wait') {
      assert.ok(result.boundedMs > 0 && result.retryAfterMs > 0);
      assert.equal(decideClosureOwner({ ...input, waitExhausted: true }).owner, 'page');
    }
    const stale = closerAuthoredStaleEligible({ headProof: proofs[headKind],
      verdict: reviewState.verdict && reviewState.verdict !== 'request-changes' ? 'settled-success' : '',
      blockingFindingState: reviewState.blockingFindingState, blockingFindingCount: reviewState.blockingFindingCount,
      checksConclusion: classified, mergeability: mergeable });
    const eligibility = isEligibleForAmaClosure(reviewState, {
      headSha: currentHead, isOpen: true, isDraft: false, mergeableState: mergeable, labels,
      statusCheckRollup: checks, branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    }, { enabled: true, eligibility: { riskClasses: ['low'] } }, { env: {}, closerAuthoredStale: stale });
    const merge = evaluateMergeEligibility({ verdict: reviewState.verdict ? 'settled-success' : '',
      leaseHeld: true, requiredChecks: checks, mergeable, prState: 'OPEN', labels,
      candidateHead: currentHead, validatedHead: attested ? currentHead : reviewed,
      branchProtectionRequired: false });
    if (headKind === 'untrusted') assert.equal(stale.decision, 'rereview-exact-head');
    if (result.owner === 'daemon-merge') {
      assert.equal(merge.eligible, true, JSON.stringify({ input, merge }));
      assert.equal(eligibility.eligible, true, JSON.stringify({ input, eligibility }));
      assert.equal(reviewState.blockingFindingCount + reviewState.nonBlockingFindingCount, 0);
    }
    if (leaseKind === 'dispatched') assert.equal(result.owner, 'wait');
    if (result.owner === 'hammer' || result.owner === 'conflict-rebase') {
      assert.equal(retryExhausted || lifetimeExhausted, false);
      if (eligibility.reasons.length) assert.equal(isHammerRemediableEligibilityMiss(eligibility.reasons, {
        reviewHandoff: leaseKind === 'handed-to-review', reviewCycleExhausted: !roundsLeft || attested,
        reviewCycleCapReached: !roundsLeft || attested,
      }), true, JSON.stringify({ input, eligibility }));
    }
    if (headKind === 'untrusted' && leaseKind !== 'dispatched') {
      assert.ok(['review', 'page'].includes(result.owner));
    }
  }
  assert.equal(combinations, 17_280);
});
