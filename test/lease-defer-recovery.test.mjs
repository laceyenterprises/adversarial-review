import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';
import { mergeLeaseAdmissionReason } from '../src/ama/merge-lease-admission.mjs';
import { isOrphanHeadReviewRequested } from '../src/first-pass-review-suppression.mjs';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const head = 'a'.repeat(40);
const stale = { dispatched: false, reason: 'not-eligible',
  reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] };

test('pushed HAM head stranded after lease timeout requests an admissible exact-head review in one tick', async () => {
  const requests = [];
  const logs = [];
  const result = await recoverStrandedCloserHead({ result: stale, closerAuthored: true,
    rootDir: '/fixture', repo: 'fixture/repo', prNumber: 8089, headSha: head,
    logger: { log: line => logs.push(line) }, requestRereviewImpl: options => {
      requests.push(options);
      return { triggered: true };
    } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].targetRevisionRef, head);
  assert.equal(isOrphanHeadReviewRequested({ rereview_requested_at: 'now',
    rereview_reason: requests[0].reason, revision_ref: head }, head), true);
  assert.equal(isOrphanHeadReviewRequested({ rereview_requested_at: 'now',
    rereview_reason: requests[0].reason, revision_ref: 'other' }, head), false);
  assert.equal(result.recoveryWait, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fixture\/repo#8089/);
  assert.ok(logs[0].includes(head));
});

test('certified retry and explicit safety holds retain their existing owner', async () => {
  for (const result of [{ dispatched: true }, { reason: 'merge-lease-timeout' },
    { ...stale, needsOperator: true }, { reason: 'hammer-stop-awaiting-input-change' }]) {
    assert.equal(await recoverStrandedCloserHead({ result, closerAuthored: true,
      headSha: head, requestRereviewImpl: () => assert.fail('unexpected review') }), null);
  }
});

test('lease admission refuses held, closed, draft, changed-head and operator-decision PRs', () => {
  const pr = { state: 'OPEN', headRefOid: head, labels: [], isDraft: false };
  assert.equal(mergeLeaseAdmissionReason(pr, head), null);
  for (const label of ['no-merge-hold', 'do-not-merge', 'merge-agent-skip']) {
    assert.equal(mergeLeaseAdmissionReason({ ...pr, labels: [{ name: label }] }, head), 'operator-hold');
  }
  assert.equal(mergeLeaseAdmissionReason({ ...pr, state: 'CLOSED' }, head), 'pr-not-open');
  assert.equal(mergeLeaseAdmissionReason({ ...pr, isDraft: true }, head), 'pr-is-draft');
  assert.equal(mergeLeaseAdmissionReason(pr, 'other'), 'head-changed');
  assert.equal(mergeLeaseAdmissionReason(pr, head, { predicate: 'awaiting-operator-decision' }), 'operator-decision');
  assert.equal(mergeLeaseAdmissionReason(pr, head, { predicate: 'merge-lease-timeout' }), null);
});

test('rendered hammer acquisition returns before the lease CLI for a held PR', t => {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const dir = mkdtempSync(join(tmpdir(), 'lease-defer-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(join(root, 'bin/hammer-verify-head.sh'), 'utf8');
  const values = { ROOT_DIR: root, HQ_ROOT: dir, PR_NUMBER: '42', REPO: 'fixture/repo', REVIEWED_SHA: 'b'.repeat(40) };
  const helper = source.slice(source.indexOf('ham_acquire_merge_lease()'), source.indexOf('ham_update_branch_conflict()'))
    .replace(/<<([A-Z_]+)>>/g, (_, key) => values[key] || 'unused')
    .replaceAll('/tmp/ham-42-', `${dir}/ham-42-`);
  const pr = JSON.stringify({ headRefOid: head, state: 'OPEN', labels: [{ name: 'no-merge-hold' }] });
  const run = spawnSync('/bin/bash', ['-c', `
HAM_NODE_BIN='${process.execPath}'
POST_REMEDIATION_SHA=${head}
ham_lease_pr_view() { printf '%s' '${pr}'; }
${helper}
ham_acquire_merge_lease
`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 20, run.stderr);
  assert.match(run.stderr, /operator-hold/);
  assert.equal(existsSync(join(dir, 'data', 'merge-leases')), false);
});
