import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold, _resetHammerStopHoldPageDebounceForTests } from '../src/ama/hammer-stop-hold.mjs';
import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';

const head = 'a'.repeat(40), reviewed = 'b'.repeat(40);
const repo = 'fixture/repository';
const missingEvidence = { evidence: 'reversal-authorization', path: 'docs/CATALOG.md',
  summary: 'no verified authority covers the reverted docs/CATALOG.md region', accepted: 0 };
const reasons = ['stale-review-head', 'primary-change-reverted'];
const logger = { log() {}, warn() {}, error() {} };

function setup(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'guard-refusal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prMetadata = { prNumber: 1, headSha: head, baseSha: 'c'.repeat(40), isOpen: true, isDraft: false,
    labels: [], mergeableState: 'MERGEABLE', statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS', status: 'COMPLETED' }] };
  const reviewState = { headSha: reviewed, verdict: 'approved', riskClass: 'low', remediationPending: false,
    blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
  const pages = [];
  const args = { rootDir, hqRoot: rootDir, repo, prNumber: 1, headSha: head, reviewedSha: reviewed,
    prMetadata, reviewState, logger, fetchPrimaryChangeImpl: async () => { throw new Error('No new fixture authority'); },
    deliverAlertImpl: async (text, options) => pages.push({ text, options }) };
  const record = (at, overrides = {}) => writeAmaAuditEntry({ hqRoot: rootDir, repo, prNumber: 1, headSha: head, now: at,
    attempt: { outcome: 'failed-without-merge', attemptPhase: 'hammer-gh-pr-merge', reason: 'predicate-not-eligible',
      validatedHead: head, eligibilityTrace: { eligible: false, reasons,
        trace: { primaryChange: { missingEvidence } } }, ...overrides } });
  record('2026-01-01T00:00:00Z');
  return { args, pages, record, rootDir, prMetadata, reviewState };
}

test('GUARDREVERT-01: second unchanged wake never dispatches and pages once across all closer routes', async t => {
  for (const route of [{}, { reviewCycleCapReached: true }, { ciBlockedHammerOwner: true },
    { orphanRecovery: { ownerProof: true, headSha: head } }]) {
    const f = setup(t);
    let launches = 0;
    const invoke = () => maybeDispatchAmaCloser({ reviewState: f.reviewState, prMetadata: f.prMetadata,
      cfg: { enabled: true, workerClass: 'hammer', branchProtection: { required: false }, eligibility: { riskClasses: ['low'] } },
      options: {}, dispatchContext: { rootDir: f.rootDir, hqRoot: f.rootDir, repo, reviewedSha: reviewed,
        liveHeadCloserAuthored: true, ...route },
      execFileImpl: async () => { launches++; throw new Error('A refused head must never launch'); },
      deliverAlertImpl: f.args.deliverAlertImpl, fetchPrimaryChangeImpl: f.args.fetchPrimaryChangeImpl, logger });
    const first = await invoke();
    assert.equal(first.reason, 'hammer-stop-awaiting-input-change');
    _resetHammerStopHoldPageDebounceForTests(); // Simulate a watcher restart.
    const second = await invoke();
    assert.equal(second.dispatched, false);
    assert.equal(second.reason, first.reason);
    assert.equal(launches, 0);
    assert.equal(f.pages.length, 1);
    assert.deepEqual(f.pages[0].options.payload.refusal.reasons, [...reasons].sort());
    assert.deepEqual(f.pages[0].options.payload.refusal.missingEvidence, missingEvidence);
    assert.match(f.pages[0].text, /Action: Restore the uncited reverted regions, then push the repaired head/);
    assert.ok(f.pages[0].text.includes(missingEvidence.summary));
  }
});

test('GUARDREVERT-01: refusal identity ignores attempt IDs and reason/object order, and includes exact missing evidence', async t => {
  const f = setup(t);
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
  f.record('2026-01-01T00:01:00Z', { eligibilityTrace: { eligible: false, reasons: [...reasons].reverse(),
    trace: { primaryChange: { missingEvidence: Object.fromEntries(Object.entries(missingEvidence).reverse()) } } } });
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
  assert.equal(f.pages.length, 1);
  const state = JSON.parse(readFileSync(join(f.rootDir, 'data/follow-up-jobs/hammer-stop-hold/fixture-repository-pr-1.json'), 'utf8'));
  assert.deepEqual(state.heads[head].refusal.missingEvidence, missingEvidence);
  f.record('2026-01-01T00:01:30Z', { outcome: 'deferred', reason: 'required-checks-pending', eligibilityTrace: null });
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold', 'a later deferral cannot erase the refusal');
  assert.equal(f.pages.length, 1);
  f.record('2026-01-01T00:02:00Z', { missingEvidence: { ...missingEvidence, summary: 'A different missing finding' } });
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
  assert.equal(f.pages.length, 2, 'a distinct refusal gets its own page');
});

test('GUARDREVERT-01: changed review or check status releases once; a new refusal establishes a new hold', async t => {
  for (const change of ['review', 'checks']) {
    const f = setup(t);
    await evaluateHammerStopHold(f.args);
    if (change === 'review') f.reviewState.refusalReviewVersion = 'New exact-head review evidence';
    else f.prMetadata.statusCheckRollup[0].conclusion = 'FAILURE';
    const released = await evaluateHammerStopHold(f.args);
    assert.equal(released.action, 'release');
    assert.ok(released.changed.includes(change));
    f.record('2026-01-01T00:03:00Z');
    assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
    assert.equal(f.pages.length, 2);
  }
});

test('GUARDREVERT-01: a new head clears refusal memory, including a force-push away and back', async t => {
  const f = setup(t);
  await evaluateHammerStopHold(f.args);
  const other = 'd'.repeat(40);
  assert.equal((await evaluateHammerStopHold({ ...f.args, headSha: other,
    prMetadata: { ...f.prMetadata, headSha: other } })).action, 'none');
  const restored = await evaluateHammerStopHold(f.args);
  assert.equal(restored.action, 'hold');
  assert.equal(f.pages.length, 2, 'a changed head clears the old page receipt');
  _resetHammerStopHoldPageDebounceForTests();
});

test('GUARDREVERT-01: newly verifiable authority releases a historical refusal without another hammer', async t => {
  const f = setup(t);
  await evaluateHammerStopHold(f.args);
  const released = await evaluateHammerStopHold({ ...f.args, fetchPrimaryChangeImpl: async () => ({
    headSha: head, hasHammerCommits: false,
  }) });
  assert.equal(released.action, 'release');
  assert.ok(released.changed.includes('primary-change-evidence'));
  assert.equal(f.pages.length, 1);
});

test('GUARDREVERT-01: canonical evidence version changes for same-head review edits with unchanged verdict/counts', () => {
  const read = body => resolveSettledReviewVerdict('/fixture', { repo, prNumber: 1, currentHeadSha: head,
    reviewRow: { review_status: 'posted', reviewer_head_sha: head, review_body: body },
    latestJobFinder: () => null, capturedReviewerPassFinder: () => null });
  const body = '## Summary\nSynthetic documentation review.\n## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
  const first = read(body), edited = read(body.replace('documentation', 'updated documentation'));
  assert.equal(first.verdict, edited.verdict);
  assert.equal(first.blockingFindingCount, edited.blockingFindingCount);
  assert.notEqual(first.evidenceVersion, edited.evidenceVersion);
  assert.match(first.evidenceVersion, /^[a-f0-9]{64}$/);
});
