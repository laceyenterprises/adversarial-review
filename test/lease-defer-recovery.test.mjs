import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStrandedCloserHead as recoverCloserHead } from '../src/ama/closer-head-recovery.mjs';
import { requestBoundedOrphanReview } from '../src/ama/orphan-review-request.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';
import { writeAmaAuditEntry, readAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { mergeLeaseAdmissionReason } from '../src/ama/merge-lease-admission.mjs';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const head = 'a'.repeat(40);
const stale = { dispatched: false, reason: 'not-eligible',
  reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] };
const recoverStrandedCloserHead = options => recoverCloserHead({ rootDir: '/fixture',
  repo: 'fixture/repo', prNumber: 42,
  requestBoundedReviewImpl: options => options.requestRereviewImpl({ ...options,
    targetRevisionRef: options.headSha, reason: `system-orphan-head-review:${options.headSha}` }),
  probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
  ...options });

test('HAMNOREREVIEW-01: an unvalidated stranded HAM head never requests review', async () => {
  let requests = 0;
  const result = await recoverStrandedCloserHead({ result: stale, closerAuthored: true,
    headSha: head, logger: { log() {} }, requestRereviewImpl: async request => {
      requests++;
      assert.equal(request.targetRevisionRef, head);
      assert.equal(request.reason, `system-orphan-head-review:${head}`);
      return { triggered: true };
    } });
  assert.equal(requests, 0);
  assert.equal(result, null);
});

test('HAMFINAL-02: proven terminal validation cannot transfer authority to review', async () => {
  assert.equal(await recoverStrandedCloserHead({ result: { ...stale, hamTerminalRemediationValidated: true },
    closerAuthored: true, headSha: head,
    requestRereviewImpl: () => assert.fail('validated head retains merge authority') }), null);
});

test('certified retry and explicit safety holds retain their existing owner', async () => {
  for (const result of [{ dispatched: true }, { reason: 'merge-lease-timeout' },
    { ...stale, needsOperator: true }, { reason: 'hammer-stop-awaiting-input-change' }]) {
    assert.equal(await recoverStrandedCloserHead({ result, closerAuthored: true,
      headSha: head, requestRereviewImpl: () => assert.fail('unexpected review') }), null);
  }
});

test('lease admission uses live holds, terminal state, draft and head, without historical stops', () => {
  const pr = { state: 'OPEN', headRefOid: head, labels: [], isDraft: false };
  assert.equal(mergeLeaseAdmissionReason(pr, head), null);
  for (const label of ['no-merge-hold', 'do-not-merge', 'merge-agent-skip']) {
    assert.equal(mergeLeaseAdmissionReason({ ...pr, labels: [{ name: label }] }, head), 'operator-hold');
  }
  assert.equal(mergeLeaseAdmissionReason({ ...pr, state: 'CLOSED' }, head), 'pr-not-open');
  assert.equal(mergeLeaseAdmissionReason({ ...pr, isDraft: true }, head), 'pr-is-draft');
  assert.equal(mergeLeaseAdmissionReason(pr, 'other'), 'head-changed');
  assert.equal(mergeLeaseAdmissionReason({ ...pr, state: 'MERGED' }, head), 'pr-merged');
  assert.equal(mergeLeaseAdmissionReason({ ...pr, state: 'MERGED', headRefOid: 'other' }, head), 'pr-merged');
});

function acquisitionFixture(t) {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const dir = mkdtempSync(join(tmpdir(), 'lease-defer-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(join(root, 'bin/hammer-verify-head.sh'), 'utf8');
  const values = { RUN_DIR: dir, ROOT_DIR: root, HQ_ROOT: dir, PR_NUMBER: '42', REPO: 'fixture/repo',
    REVIEWED_SHA: 'b'.repeat(40), REVIEWER: 'claude', RISK_CLASS: 'critical' };
  const helper = source.slice(source.indexOf('ham_acquire_merge_lease()'), source.indexOf('ham_update_branch_conflict()'))
    .replace(/<<([A-Z_]+)>>/g, (_, key) => values[key] || 'unused')
    .replace(' acquire \\', ` acquire --root-dir '${dir}' \\`);
  return { dir, run(pr, probeState = pr.state) {
    return spawnSync('/bin/bash', ['-c', `
HAM_NODE_BIN='${process.execPath}'
POST_REMEDIATION_SHA=${head}
BASE_BRANCH=main
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=${'d'.repeat(40)}; }
HAM_MERGE_LEASE_WAIT_SECONDS=0
ham_release_merge_lease() { :; }
ham_lease_pr_view() {
  if [[ "$*" == *--jq* ]]; then printf '%s' '${probeState}'; else printf '%s' '${JSON.stringify(pr)}'; fi
}
${helper}
ham_acquire_merge_lease
printf '\nexit:%s outcome:%s held:%s' "$?" "$HAM_PHASE_OUTCOME" "$HAM_MERGE_LEASE_HELD"
`], { encoding: 'utf8', timeout: 10_000 });
  } };
}

const openPr = { headRefOid: head, state: 'OPEN', labels: [], isDraft: false, statusCheckRollup: [] };

for (const [reason, pr] of [
  ['operator-hold', { ...openPr, labels: [{ name: 'no-merge-hold' }] }],
  ['pr-not-open', { ...openPr, state: 'CLOSED' }],
  ['pr-is-draft', { ...openPr, isDraft: true }],
  ['head-changed', { ...openPr, headRefOid: 'c'.repeat(40) }],
]) {
  test(`rendered hammer admission audits ${reason} before acquiring a lease`, t => {
    const { dir, run } = acquisitionFixture(t);
    const result = run(pr);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exit:20 outcome:merge-lease-admission-refused held:$/);
    assert.match(result.stderr, new RegExp(reason));
    assert.equal(existsSync(join(dir, 'data', 'merge-leases')), false);
    const audit = readAmaAuditEntry(dir, 'fixture/repo', 42, head);
    const outcome = reason === 'head-changed' ? 'superseded'
      : reason === 'pr-not-open' ? 'failed-without-merge' : 'deferred';
    assert.equal(audit.status, outcome);
    assert.equal(audit.attempts.at(-1).outcome, outcome);
    assert.equal(audit.attempts.at(-1).reason, `merge-lease-admission:${reason}`);
    assert.equal(audit.attempts.at(-1).attemptPhase, 'hammer-lease-admission');
    assert.equal(readHammerStopForHead({ hqRoot: dir,
      repo: 'fixture/repo', prNumber: 42, headSha: head }), null);
  });
}

for (const gate of ['operator-hold', 'pr-is-draft']) {
  test(`clearing admission ${gate} leaves no hammer stop or false ownerless page`, async t => {
    const { dir, run } = acquisitionFixture(t);
    const refusedPr = gate === 'operator-hold'
      ? { ...openPr, labels: [{ name: 'no-merge-hold' }] } : { ...openPr, isDraft: true };
    assert.equal(run(refusedPr).status, 0);
    const decision = await evaluateHammerStopHold({ rootDir: dir, hqRoot: dir,
      repo: 'fixture/repo', prNumber: 42, headSha: head, prMetadata: openPr,
      logger: { log() {}, error() {} }, deliverAlertImpl: () => assert.fail('false SEV1 page') });
    assert.equal(decision.action, 'none');
    assert.match(run(openPr).stdout, /exit:0 outcome: held:1$/);
  });
}

test('rendered admission recognizes a merge race without a refusal audit or lease', t => {
  const { dir, run } = acquisitionFixture(t);
  const result = run({ ...openPr, state: 'MERGED' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exit:20 outcome:already-merged held:$/);
  assert.equal(readAmaAuditEntry(dir, 'fixture/repo', 42, head), null);
  assert.equal(existsSync(join(dir, 'data', 'merge-leases')), false);
});

test('admission audit failure cannot acquire a lease or report a successful refusal', t => {
  const { dir, run } = acquisitionFixture(t);
  writeFileSync(join(dir, 'dispatch'), 'not a directory');
  const result = run({ ...openPr, isDraft: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exit:70 outcome: held:$/);
  assert.equal(existsSync(join(dir, 'data', 'merge-leases')), false);
});

for (const liveState of ['OPEN', 'MERGED']) {
  test(`sticky-success admission audit verifies live ${liveState} state before reporting a merge race`, t => {
    const { dir, run } = acquisitionFixture(t);
    writeAmaAuditEntry({ hqRoot: dir, repo: 'fixture/repo', prNumber: 42, headSha: head,
      attempt: { outcome: 'succeeded' } });
    const result = run({ ...openPr, isDraft: true }, liveState);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, liveState === 'MERGED'
      ? /exit:20 outcome:already-merged held:$/ : /exit:1 outcome: held:$/);
    assert.equal(readAmaAuditEntry(dir, 'fixture/repo', 42, head).status, 'succeeded');
    assert.equal(existsSync(join(dir, 'data', 'merge-leases')), false);
  });
}

for (const change of ['base', 'conflicting', 'lease-timeout']) {
  test(`rendered same-head re-dispatch ignores a historical stop after ${change}`, async t => {
    const { dir, run } = acquisitionFixture(t);
    const common = { hqRoot: dir, repo: 'fixture/repo', prNumber: 42, headSha: head };
    writeAmaAuditEntry({ ...common, now: '2026-10-11T10:00:00Z',
      attempt: { outcome: change === 'lease-timeout' ? 'deferred' : 'failed-without-merge',
        reason: change === 'lease-timeout' ? 'merge-lease-timeout' : 'awaiting-operator-decision' } });
    const prMetadata = { headSha: head, baseSha: 'base-0', mergeableState: 'MERGEABLE', statusCheckRollup: [] };
    const evaluate = (metadata, now) => evaluateHammerStopHold({ ...common, rootDir: dir,
      prMetadata: metadata, now, logger: { log() {}, error() {} }, deliverAlertImpl: async () => {} });
    if (change !== 'lease-timeout') {
      assert.equal((await evaluate(prMetadata, '2026-10-11T10:01:00Z')).action, 'hold');
      const released = await evaluate({ ...prMetadata,
        ...(change === 'base' ? { baseSha: 'base-1' } : { mergeableState: 'CONFLICTING' }) }, '2026-10-11T10:02:00Z');
      assert.equal(released.action, 'release');
    }
    writeAmaAuditEntry({ ...common, now: '2026-10-11T10:03:00Z', attempt: { outcome: 'in_progress' } });
    assert.equal(readHammerStopForHead(common)?.predicate || null,
      change === 'lease-timeout' ? null : 'awaiting-operator-decision');
    const result = run(openPr);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exit:0 outcome: held:1$/);
    assert.equal(readAmaAuditEntry(dir, 'fixture/repo', 42, head).status, 'in_progress');
  });
}

for (const reason of ['label-no-merge-hold', 'pr-not-open', 'risk-class-not-permitted',
  'branch-protection-missing-gate', 'fast-merge-state-unsupported', 'duplicate-family-unresolved', 'ci-not-green']) {
  test(`exact-head recovery rejects co-occurring ${reason}`, async () => {
    assert.equal(await recoverStrandedCloserHead({ result: { ...stale, reasons: [...stale.reasons, reason] },
      closerAuthored: true, headSha: head, requestRereviewImpl: () => assert.fail('unexpected review') }), null);
  });
}

for (const reason of ['comment-only-verdict-settled', 'comment-only-final-round-push-unproven',
  'malformed-title-terminal', 'argus-security-queued', 'pr-not-open']) {
  test(`refused exact-head request ${reason} leaves recovery to the watchdog`, async () => {
    assert.equal(await recoverStrandedCloserHead({ result: stale, closerAuthored: true, headSha: head,
      logger: { log: () => assert.fail('unexpected wait log') },
      requestRereviewImpl: async () => ({ triggered: false, reason }) }), null);
  });
}

test('already-pending exact-head review retains reviewer ownership', async () => {
  const result = await recoverStrandedCloserHead({ result: stale, closerAuthored: true, headSha: head,
    logger: { log() {} }, requestRereviewImpl: async () => ({ triggered: false,
      status: 'already-pending', reason: 'review-already-pending',
      reviewRow: { rereview_requested_at: 'now', rereview_reason: `system-orphan-head-review:${head}`, revision_ref: head } }) });
  assert.equal(result, null);
});

for (const leaseHead of [head, 'b'.repeat(40)]) {
  test(`live closer lease on ${leaseHead === head ? 'current' : 'prior'} head prevents review takeover`, async t => {
    const { dir } = acquisitionFixture(t);
    acquireAmaCloserLease({ rootDir: dir, repo: 'fixture/repo', prNumber: 42,
      headSha: leaseHead, watcherPid: process.pid });
    assert.equal(await recoverStrandedCloserHead({ rootDir: dir, result: stale,
      closerAuthored: true, headSha: head,
      requestRereviewImpl: () => assert.fail('live hammer must retain ownership') }), null);
  });
}

for (const status of ['queued', 'running', 'unknown', 'succeeded']) {
  test(`${status} hammer dispatch evidence gates exact-head recovery`, async t => {
    const { dir } = acquisitionFixture(t);
    const records = join(dir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, `fixture__repo-pr-42-${head}.json`), JSON.stringify({
      repo: 'fixture/repo', prNumber: 42, headSha: head, state: 'dispatched', launchRequestId: `launch-${status}` }));
    let requests = 0;
    const result = await recoverStrandedCloserHead({ rootDir: dir, result: stale,
      closerAuthored: true, headSha: head, logger: { log() {} },
      probeOwnershipImpl: options => probeOrphanOwnership({ ...options,
        readStatusImpl: async () => status === 'unknown' ? { ok: false }
          : { ok: true, row: { status } } }),
      requestRereviewImpl: () => { requests++; return { triggered: true }; } });
    assert.equal(requests, 0);
    assert.equal(result, null);
  });
}

test('unreadable ownership evidence defers exact-head recovery', async () => {
  assert.equal(await recoverStrandedCloserHead({ result: stale, closerAuthored: true,
    headSha: head, logger: { warn() {} },
    probeOwnershipImpl: () => { throw new Error('unreadable'); },
    requestRereviewImpl: () => assert.fail('uncertain ownership') }), null);
});


test('pending without exact-head request has no reviewer owner', async () => {
  assert.equal(await recoverStrandedCloserHead({ result: stale, closerAuthored: true,
    headSha: head, requestRereviewImpl: async () => ({ status: 'already-pending',
      reviewRow: { review_status: 'pending', revision_ref: head, rereview_requested_at: null } }) }), null);
});

test('timeout-exhausted head cannot be reset repeatedly after closer recovery', async t => {
  const { dir } = acquisitionFixture(t);
  let calls = 0;
  const options = { rootDir: dir, result: stale, closerAuthored: true, headSha: head,
    requestBoundedReviewImpl: requestBoundedOrphanReview, logger: { log() {} },
    requestRereviewImpl: async () => { calls++; return { triggered: true }; } };
  assert.equal(await recoverStrandedCloserHead(options), null);
  const failed = { ...options, reviewStateRow: { review_status: 'failed', reviewer_head_sha: head } };
  assert.equal(await recoverStrandedCloserHead(failed), null);
  assert.equal(await recoverStrandedCloserHead(failed), null);
  assert.equal(await recoverStrandedCloserHead(options), null, 'durable guard survives missing review row');
  assert.equal(calls, 0);
});

for (const reason of ['operator-hold', 'pr-is-draft', 'pr-not-open']) {
  test(`admission ${reason} neither sets nor clears a prior hammer decision`, t => {
    const { dir, run } = acquisitionFixture(t);
    writeAmaAuditEntry({ hqRoot: dir, repo: 'fixture/repo', prNumber: 42, headSha: head,
      attempt: { outcome: 'failed-without-merge', reason: 'operator-decision',
        attemptPhase: 'hammer-gh-pr-merge', startedAt: '2026-10-11T00:00:00Z' } });
    const pr = reason === 'operator-hold' ? { ...openPr, labels: [{ name: 'no-merge-hold' }] }
      : reason === 'pr-is-draft' ? { ...openPr, isDraft: true } : { ...openPr, state: 'CLOSED' };
    assert.equal(run(pr).status, 0);
    assert.equal(readHammerStopForHead({ hqRoot: dir, repo: 'fixture/repo', prNumber: 42,
      headSha: head }).predicate, 'operator-decision');
  });
}
