import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { amaAuditFilePath, writeAmaAuditEntry } from '../src/ama/audit.mjs';
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

test('GUARDREVERT-01: packaging after a refusal never dispatches or re-pages across all closer routes', async t => {
  const routes = [{}, { reviewCycleCapReached: true }, { ciBlockedHammerOwner: true },
    { orphanRecovery: { ownerProof: true, headSha: head } }];
  for (const { route, keepRefusalAudit } of routes.flatMap(route =>
    [true, false].map(keepRefusalAudit => ({ route, keepRefusalAudit })))) {
    const f = setup(t);
    let launches = 0;
    let holdEvaluations = 0;
    let ownershipProbes = 0;
    const invoke = () => maybeDispatchAmaCloser({ reviewState: f.reviewState, prMetadata: f.prMetadata,
      cfg: { enabled: true, workerClass: 'hammer', branchProtection: { required: false }, eligibility: { riskClasses: ['low'] } },
      options: {}, dispatchContext: { rootDir: f.rootDir, hqRoot: f.rootDir, repo, reviewedSha: reviewed,
        liveHeadCloserAuthored: true, ...route },
      execFileImpl: async () => { launches++; throw new Error('A refused head must never launch'); },
      evaluateHammerStopHoldImpl: async args => {
        holdEvaluations++;
        return evaluateHammerStopHold(args);
      },
      readLaunchRequestStatusImpl: async () => { ownershipProbes++; return { status: 'running' }; },
      deliverAlertImpl: f.args.deliverAlertImpl, fetchPrimaryChangeImpl: f.args.fetchPrimaryChangeImpl, logger });
    const first = await invoke();
    assert.equal(first.reason, 'hammer-stop-awaiting-input-change');
    assert.equal(first.skipMergeAgent, true, 'the refusal fence must prevent legacy fallback');
    assert.equal(first.recoveryWait, true);
    assert.equal(first.hammerStop.deterministic, true);
    assert.equal(first.hammerStop.refusal.repairable, true);
    assert.deepEqual(first.hammerStop.refusal.missingEvidence, missingEvidence);
    assert.equal(holdEvaluations, 1, 'the pre-route fence evaluates the hold once per tick');
    assert.equal(ownershipProbes, 0, 'a held refusal fences ownership probes');
    f.record('2026-01-01T00:01:00Z', { reason: 'missing-dispatch-phase-scripts',
      reasons: ['missing-dispatch-phase-scripts'], eligibilityTrace: null });
    if (!keepRefusalAudit) {
      const path = amaAuditFilePath(f.rootDir, repo, 1, head);
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      doc.attempts = doc.attempts.slice(-1);
      writeFileSync(path, JSON.stringify(doc));
    }
    _resetHammerStopHoldPageDebounceForTests(); // Simulate a watcher restart.
    const second = await invoke();
    assert.equal(second.dispatched, false);
    assert.equal(second.reason, first.reason);
    assert.equal(second.skipMergeAgent, true);
    assert.equal(second.recoveryWait, true);
    assert.equal(launches, 0);
    assert.equal(holdEvaluations, 2);
    assert.equal(ownershipProbes, 0);
    assert.equal(f.pages.length, 1);
    assert.equal(f.pages[0].options.event, 'ama_closer.hammer_stop_hold');
    assert.deepEqual(f.pages[0].options.payload.refusal.reasons, [...reasons].sort());
    assert.deepEqual(f.pages[0].options.payload.refusal.missingEvidence, missingEvidence);
    assert.match(f.pages[0].text, /Action: Restore the uncited reverted regions, then push the repaired head/);
    assert.ok(f.pages[0].text.includes(missingEvidence.summary));
  }
});

test('GUARDREVERT-01: failed refusal pages retry on the next tick before debouncing success', async t => {
  const f = setup(t);
  const errors = [];
  let deliveries = 0;
  const args = { ...f.args, now: '2026-01-01T00:01:00Z',
    logger: { ...logger, error: message => errors.push(JSON.parse(message)) },
    deliverAlertImpl: async (text, options) => {
      deliveries++;
      if (deliveries === 1) throw new Error('Alert transport timeout');
      await f.args.deliverAlertImpl(text, options);
    } };
  const failed = await evaluateHammerStopHold(args);
  assert.equal(failed.action, 'hold');
  assert.equal(failed.hammerStop.paged, false);
  const statePath = join(f.rootDir, 'data/follow-up-jobs/hammer-stop-hold/fixture-repository-pr-1.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).heads[head].pagedAt, null);
  assert.equal(errors[0].event, 'ama_closer.hammer_stop_hold_page_failed');

  const now = '2026-01-01T00:02:00Z';
  const retried = await evaluateHammerStopHold({ ...args, now });
  assert.equal(retried.hammerStop.paged, true);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).heads[head].pagedAt, now);
  await evaluateHammerStopHold({ ...args, now });
  assert.equal(deliveries, 2, 'only the failed delivery is retried');
  assert.equal(f.pages.length, 1);
  assert.equal(f.pages[0].options.event, 'ama_closer.hammer_stop_hold');
});

test('GUARDREVERT-01: successful refusal page debounces when hold persistence fails', async t => {
  const f = setup(t);
  // A file in place of the store directory fails writes even under a privileged user.
  mkdirSync(join(f.rootDir, 'data/follow-up-jobs'), { recursive: true });
  writeFileSync(join(f.rootDir, 'data/follow-up-jobs/hammer-stop-hold'), 'blocked store');
  const errors = [];
  const args = { ...f.args, logger: { ...logger, error: message => errors.push(JSON.parse(message)) } };
  for (let tick = 0; tick < 3; tick++) {
    const held = await evaluateHammerStopHold(args);
    assert.equal(held.action, 'hold');
    assert.equal(held.hammerStop.paged, true);
  }
  assert.equal(errors.filter(error => error.event === 'ama_closer.hammer_stop_hold_persist_failed').length, 3);
  assert.equal(f.pages.length, 1, 'a delivered page must survive failed receipt writes in memory');
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
