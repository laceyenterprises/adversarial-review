// Tests for follow-up-retrigger-review-label.mjs.
//
// Covers the happy path (label triggers review reset, audit+label-removal
// +ack all succeed), idempotency on a second consumption, and the
// classified error paths (missing labelEvent, missing revisionRef,
// review row already pending → noop, requestReviewRereview throws).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createGitHubPRLabelControlsAdapter,
  legacyLabelEventFromControlResult,
} from '../src/adapters/operator/github-pr-label-controls/index.mjs';
import { latestMatchingScopedTimelineLabelEvent } from '../src/github-label-events.mjs';

import {
  RETRIGGER_REVIEW_LABEL,
  retryPendingRetriggerReviewAckComments,
  tryRetriggerReviewFromLabel,
} from '../src/follow-up-retrigger-review-label.mjs';

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'retrigger-review-test-'));
  mkdirSync(path.join(root, 'data', 'follow-up-jobs', 'label-consumptions'), {
    recursive: true,
  });
  mkdirSync(path.join(root, 'data', 'operator-mutations'), { recursive: true });
  return root;
}

function makeStubExec({ recordedCalls = [], errors = {} } = {}) {
  return async function execFileImpl(file, args = [], _opts = {}) {
    recordedCalls.push({ file, args });
    if (errors.file === file) {
      const err = new Error(errors.message || 'stub error');
      if (errors.killed) err.killed = true;
      throw err;
    }
    if (file === 'gh' && args[0] === 'api' && args.includes('--paginate')) {
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

function stubAuditAppender() {
  const rows = [];
  return {
    appendAuditRow(_dir, row) {
      rows.push(row);
    },
    findAuditRow() {
      return null;
    },
    rows,
  };
}

function defaultArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 527,
    labelActor: 'merge-agent',
    labelEvent: {
      id: 'EVT_test_abc',
      actor: 'merge-agent',
      createdAt: '2026-05-16T18:00:00Z',
    },
    revisionRef: 'c31e345bb216cdb465cc76804d7a2b3f9441366e',
    execFileImpl: makeStubExec(),
    ...overrides,
  };
}

test('label-event-missing when no labelEvent passed', async () => {
  const root = makeTempRoot();
  const calls = [];
  const result = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root),
    execFileImpl: makeStubExec({ recordedCalls: calls }),
    labelEvent: null,
    rereviewImpl: () => assert.fail('should not call rereview when labelEvent missing'),
  });
  assert.equal(result.outcome, 'label-event-missing');
  assert.equal(result.labelRemoved, false);
  assert.equal(calls.length, 0);
});

for (const firstObservation of ['stale-snapshot', 'missing-anchor']) {
  test(`CAPROUTE-01: ${firstObservation} keeps the request for the next current-head tick`, async () => {
    const root = makeTempRoot();
    const calls = [];
    const audit = stubAuditAppender();
    const headB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const anchor = { __typename: 'PullRequestCommit', id: 'commit-B',
      commit: { oid: headB, committedDate: '2026-10-11T10:00:00Z' } };
    const labeled = { __typename: 'LabeledEvent', id: 'label-B',
      label: { name: RETRIGGER_REVIEW_LABEL }, actor: { login: 'merge-agent' },
      createdAt: '2026-10-11T10:01:00Z' };
    let nodes = firstObservation === 'missing-anchor' ? [labeled] : [anchor, labeled];
    const adapter = createGitHubPRLabelControlsAdapter({
      // The live PR is already at B; the tick snapshot or timeline can lag.
      fetchLatestLabelEventImpl: async () => latestMatchingScopedTimelineLabelEvent(nodes, RETRIGGER_REVIEW_LABEL, headB),
    });
    let resets = 0;
    const tick = async (revisionRef) => {
      const subjectRef = { domainId: 'code-pr', subjectExternalId: 'laceyenterprises/agent-os#527', revisionRef };
      const control = await adapter.observeLabelControl(subjectRef, revisionRef, RETRIGGER_REVIEW_LABEL);
      const result = await tryRetriggerReviewFromLabel(defaultArgs(root, {
        labelEvent: legacyLabelEventFromControlResult(control, RETRIGGER_REVIEW_LABEL),
        labelControlReason: control.reason,
        revisionRef,
        execFileImpl: makeStubExec({ recordedCalls: calls }),
        appendAuditRow: audit.appendAuditRow,
        findAuditRow: audit.findAuditRow,
        rereviewImpl: () => { resets++; return { triggered: true, status: 'pending' }; },
      }));
      return { control, result };
    };
    const first = await tick(firstObservation === 'stale-snapshot' ? defaultArgs(root).revisionRef : headB);
    assert.equal(first.control.applied, false);
    assert.ok(firstObservation === 'stale-snapshot'
      ? first.control.reason.startsWith('stale:')
      : first.control.reason === 'missing-label-event');
    assert.equal(first.result.labelRemoved, false);
    assert.equal(calls.length, 0);
    assert.equal(resets, 0);
    assert.equal(audit.rows.length, 0);
    assert.deepEqual(readdirSync(path.join(root, 'data', 'follow-up-jobs', 'label-consumptions')), []);

    nodes = [anchor, labeled];
    const second = await tick(headB);
    assert.equal(second.control.applied, true);
    assert.equal(second.result.outcome, 'review-retriggered');
    assert.equal(resets, 1);
    assert.equal(audit.rows.length, 1);
    assert.ok(calls.some((call) => call.args.includes('--remove-label')));
  });
}

for (const labelControlReason of ['non-attributable', 'untrusted-actor', 'missing-audit-fields']) {
  test(`CAPROUTE-01: ${labelControlReason} removes only conclusively rejected requests`, async () => {
    const root = makeTempRoot();
    const calls = [];
    const result = await tryRetriggerReviewFromLabel(defaultArgs(root, {
      labelEvent: null, labelControlReason,
      execFileImpl: makeStubExec({ recordedCalls: calls }),
      rereviewImpl: () => assert.fail('rejected or incomplete evidence must not reset review'),
    }));
    const expectedRemoval = labelControlReason !== 'missing-audit-fields';
    assert.equal(result.labelRemoved, expectedRemoval);
    assert.equal(calls.length, expectedRemoval ? 1 : 0);
    if (expectedRemoval) assert.ok(calls[0].args.includes('--remove-label'));
  });
}

test('missing-revision-ref when revisionRef cannot be resolved', async () => {
  const root = makeTempRoot();
  const result = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root),
    revisionRef: '',
    rereviewImpl: () => assert.fail('should not call rereview when revisionRef missing'),
  });
  assert.equal(result.outcome, 'missing-revision-ref');
  assert.equal(result.ackComment?.posted, false);
});

test('happy path: triggers review-status-reset, writes audit, removes label, posts ack', async () => {
  const root = makeTempRoot();
  const recordedExec = [];
  const audit = stubAuditAppender();
  const result = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, {
      execFileImpl: makeStubExec({ recordedCalls: recordedExec }),
    }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => ({
      triggered: true,
      status: 'pending',
      reason: 'review-status-reset',
      reviewRow: { repo: 'laceyenterprises/agent-os', pr_number: 527, review_status: 'pending' },
    }),
  });
  assert.equal(result.outcome, 'review-retriggered');
  assert.equal(result.rereviewResult.triggered, true);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].verb, 'hq.adversarial.retrigger-review');
  assert.equal(audit.rows[0].outcome, 'triggered');
  // label removed via `gh pr edit --remove-label retrigger-review`
  const removeCall = recordedExec.find(
    (c) => c.file === 'gh' && c.args.includes('--remove-label') && c.args.includes(RETRIGGER_REVIEW_LABEL)
  );
  assert.ok(removeCall, 'expected gh pr edit --remove-label retrigger-review call');
  // consumption record written
  const consumptionFiles = readdirSync(
    path.join(root, 'data', 'follow-up-jobs', 'label-consumptions')
  );
  assert.equal(consumptionFiles.length, 1);
  const doc = JSON.parse(
    readFileSync(
      path.join(root, 'data', 'follow-up-jobs', 'label-consumptions', consumptionFiles[0]),
      'utf8'
    )
  );
  assert.equal(doc.label, RETRIGGER_REVIEW_LABEL);
  assert.equal(doc.auditStatus, 'written');
  assert.equal(doc.labelRemoved, true);
  assert.equal(doc.rereviewResult.triggered, true);
});

test('noop when rereview returns triggered=false (already pending), still consumes label', async () => {
  const root = makeTempRoot();
  const recordedExec = [];
  const audit = stubAuditAppender();
  const result = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, {
      execFileImpl: makeStubExec({ recordedCalls: recordedExec }),
    }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => ({
      triggered: false,
      status: 'blocked',
      reason: 'already-pending',
      reviewRow: { review_status: 'pending' },
    }),
  });
  assert.equal(result.outcome, 'noop:already-pending');
  assert.equal(audit.rows[0].outcome, 'noop:already-pending');
  // even on noop the label should still be removed
  const removeCall = recordedExec.find(
    (c) => c.args.includes('--remove-label') && c.args.includes(RETRIGGER_REVIEW_LABEL)
  );
  assert.ok(removeCall, 'noop path must still remove the label');
});

test('idempotency: second call with same labelEvent returns label-already-consumed', async () => {
  const root = makeTempRoot();
  const audit = stubAuditAppender();
  const firstExec = [];
  await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, { execFileImpl: makeStubExec({ recordedCalls: firstExec }) }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => ({ triggered: true, status: 'pending', reason: 'review-status-reset' }),
  });
  assert.equal(audit.rows.length, 1);

  let rereviewCalledAgain = false;
  const secondExec = [];
  const second = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, { execFileImpl: makeStubExec({ recordedCalls: secondExec }) }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => {
      rereviewCalledAgain = true;
      return { triggered: true };
    },
  });
  assert.equal(second.outcome, 'label-already-consumed');
  assert.equal(rereviewCalledAgain, false, 'rereview must not be re-run when consumption exists');
  // Audit not re-appended (auditStatus was already "written")
  assert.equal(audit.rows.length, 1);
});

test('rereview-call-failed when requestReviewRereview throws', async () => {
  const root = makeTempRoot();
  const result = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root),
    rereviewImpl: () => {
      throw new Error('synthetic-db-failure');
    },
  });
  assert.equal(result.outcome, 'rereview-call-failed');
  assert.match(result.detail, /synthetic-db-failure/);
});

test('label removal failure is recoverable on next tick; first call still writes audit', async () => {
  const root = makeTempRoot();
  const audit = stubAuditAppender();
  // Stub that fails on the --remove-label call
  let removeAttempts = 0;
  const execFileImpl = async (file, args) => {
    if (file === 'gh' && args.includes('--remove-label')) {
      removeAttempts += 1;
      const err = new Error('label not found');
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
  const first = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, { execFileImpl }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => ({ triggered: true, status: 'pending', reason: 'review-status-reset' }),
  });
  assert.equal(first.outcome, 'review-retriggered');
  assert.equal(audit.rows.length, 1, 'audit must be written even when label removal fails');
  // Consumption file records labelRemoved=false
  const file = readdirSync(
    path.join(root, 'data', 'follow-up-jobs', 'label-consumptions')
  )[0];
  const doc = JSON.parse(
    readFileSync(
      path.join(root, 'data', 'follow-up-jobs', 'label-consumptions', file),
      'utf8'
    )
  );
  assert.equal(doc.labelRemoved, false);
  assert.match(doc.labelRemoveError || '', /label not found/);
  assert.equal(removeAttempts, 1);

  // Second call retries residuals including the label removal — still fails
  const second = await tryRetriggerReviewFromLabel({
    ...defaultArgs(root, { execFileImpl }),
    appendAuditRow: audit.appendAuditRow,
    findAuditRow: audit.findAuditRow,
    rereviewImpl: () => assert.fail('rereview must not re-run on residual retry'),
  });
  assert.equal(second.outcome, 'label-already-consumed-removal-failed');
  assert.equal(removeAttempts, 2);
});

test('retryPendingRetriggerReviewAckComments only attempts records that need retry', async () => {
  const root = makeTempRoot();
  // Empty dir → no-op
  const empty = await retryPendingRetriggerReviewAckComments({
    rootDir: root,
    execFileImpl: makeStubExec(),
  });
  assert.equal(empty.attempted, 0);
  assert.equal(empty.posted, 0);
});

test('CAPROUTE-01: removal failure leaves an unattributed label retryable without resetting review', async () => {
  const root = makeTempRoot();
  const args = defaultArgs(root, { labelEvent: null,
    labelControlReason: 'non-attributable',
    rereviewImpl: () => assert.fail('unattributed label must not reset review') });
  await assert.rejects(tryRetriggerReviewFromLabel({ ...args,
    execFileImpl: async () => { throw new Error('remove failed'); } }), /remove failed/);
  const result = await tryRetriggerReviewFromLabel(args);
  assert.equal(result.labelRemoved, true);
});


test('FINALROUND-01: missing labeled event is honored after a durable bounded wait on the current head', async () => {
  const root = makeTempRoot();
  const logs = [];
  const requests = [];
  const audit = stubAuditAppender();
  const args = { ...defaultArgs(root), ...audit, labelEvent: null,
    env: { RETRIGGER_REVIEW_MISSING_EVENT_WAIT_MS: '300000' },
    logger: { warn: (line) => logs.push(line) },
    rereviewImpl: (request) => { requests.push(request); return { triggered: true, status: 'pending' }; } };
  const first = await tryRetriggerReviewFromLabel({ ...args, now: () => '2026-10-12T01:43:00Z' });
  assert.equal(first.outcome, 'label-event-missing');
  const before = await tryRetriggerReviewFromLabel({ ...args, now: () => '2026-10-12T01:47:59Z' });
  assert.equal(before.outcome, 'label-event-missing');
  await tryRetriggerReviewFromLabel({ ...args, now: () => '2026-10-12T01:48:00Z' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].targetRevisionRef, args.revisionRef);
  assert.match(logs[0], /labeled event missing.*current head/);
  await tryRetriggerReviewFromLabel({ ...args, now: () => '2026-10-12T01:49:00Z' });
  assert.equal(requests.length, 1, 'same observed label is consumed once');
  const changed = await tryRetriggerReviewFromLabel({ ...args, revisionRef: 'd'.repeat(40), now: () => '2026-10-12T01:49:00Z' });
  assert.equal(changed.outcome, 'label-event-missing', 'head movement starts its own bound');
});
