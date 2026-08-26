/** ASR-06 — blocking authority on `high`, and fail-closed on everything else.
 *
 * Two contracts are under test and they pull in opposite directions, which is
 * why both are asserted as PROPERTIES over the whole state space rather than as
 * a list of remembered cases:
 *
 *   AUTHORITY IS NARROW. Only `high` blocks. A rubric that blocks on medium
 *                        findings freezes the dependency lane, and the lane it
 *                        freezes is the one that already goes unattended for
 *                        hours.
 *   SILENCE IS NOT YES.  No state except a real approval may satisfy the gate.
 *
 * The property tests are the load-bearing ones. A future state added to
 * `ARGUS_VERDICT_STATES` without a decision about its authority fails
 * `no state but approved satisfies the gate` immediately, which is the whole
 * point of keeping the satisfying set in one frozen table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARGUS_GATE_REASONS,
  ARGUS_REVIEW_STALL_DEADLINE_MS,
  ARGUS_VERDICT_STATES,
  advisoryArgusFindings,
  argusVerdictBlocksGate,
  argusVerdictSatisfiesGate,
  blockingArgusFindings,
  resolveArgusSecurityVerdict,
} from '../src/argus-security-verdict.mjs';
import {
  completeArgusJob,
  enqueueArgusSecurityReview,
  failArgusJob,
  claimNextArgusJob,
} from '../src/argus-security-queue.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REASONS = [{ trigger: 'bot-author', detail: 'app/dependabot' }];

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'asr06-verdict-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function enqueue(root, { headSha = HEAD, enqueuedAt = new Date().toISOString() } = {}) {
  return enqueueArgusSecurityReview({
    rootDir: root,
    repo: REPO,
    prNumber: 909,
    headSha,
    reasons: REASONS,
    enqueuedAt,
  });
}

function resolve(root, overrides = {}) {
  return resolveArgusSecurityVerdict({
    rootDir: root,
    repo: REPO,
    prNumber: 909,
    headSha: HEAD,
    ...overrides,
  });
}

function resultDoc({ verdict = 'approve', findings = [] } = {}) {
  return {
    schemaVersion: 1,
    repo: REPO,
    prNumber: 909,
    headSha: HEAD,
    verdict,
    blocksMerge: findings.some((f) => f.severity === 'high'),
    isApproval: verdict === 'approve',
    highestSeverity: findings[0]?.severity ?? null,
    findings,
  };
}

// ---------------------------------------------------------------------------
// The authority decision: `high` blocks, medium and low never do.
// ---------------------------------------------------------------------------

test('a high finding blocks the merge', () => withRoot((root) => {
  const { jobPath } = enqueue(root);
  completeArgusJob({
    rootDir: root,
    jobPath,
    result: resultDoc({
      verdict: 'block',
      findings: [{ severity: 'high', category: 'install_execution', title: 'postinstall added' }],
    }),
  });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.BLOCKED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
  assert.equal(verdict.blockingFindings.length, 1);
}));

test('medium and low findings are advisory and never block', () => withRoot((root) => {
  const { jobPath } = enqueue(root);
  completeArgusJob({
    rootDir: root,
    jobPath,
    result: resultDoc({
      verdict: 'approve',
      findings: [
        { severity: 'medium', category: 'version_distance', title: 'major bump' },
        { severity: 'low', category: 'graph_delta', title: '3 transitives added' },
      ],
    }),
  });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.APPROVED);
  assert.equal(verdict.blocks, false);
  assert.equal(verdict.satisfiesGate, true);
  // "Never blocks" must not decay into "never surfaces".
  assert.equal(verdict.advisoryFindings.length, 2);
}));

test('a high finding outranks a recorded approve verdict', () => withRoot((root) => {
  // The two can only disagree on a truncated or hand-edited record. The findings
  // are the evidence; the verdict field is a summary of them. Trusting the
  // summary over the evidence is exactly how a `high` gets merged.
  const { jobPath } = enqueue(root);
  completeArgusJob({
    rootDir: root,
    jobPath,
    result: {
      ...resultDoc({ verdict: 'approve' }),
      isApproval: true,
      blocksMerge: false,
      findings: [{ severity: 'high', category: 'credential_surface', title: 'token in fixture' }],
    },
  });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.BLOCKED);
  assert.equal(verdict.satisfiesGate, false);
}));

test('needs_verification neither blocks nor approves', () => withRoot((root) => {
  // SPEC.md is explicit on both halves: it is advisory severity, so the
  // high-only rule forbids blocking; and it "is not an approval". It reports
  // missing EVIDENCE, so it holds without asserting a defect.
  const { jobPath } = enqueue(root);
  completeArgusJob({ rootDir: root, jobPath, result: resultDoc({ verdict: 'needs_verification' }) });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.NEEDS_VERIFICATION);
  assert.equal(verdict.blocks, false);
  assert.equal(verdict.satisfiesGate, false);
}));

// ---------------------------------------------------------------------------
// Fail closed: absence, error, and silence.
// ---------------------------------------------------------------------------

test('a failed Argus job fails closed', () => withRoot((root) => {
  const { jobPath } = enqueue(root);
  failArgusJob({ rootDir: root, jobPath, error: new Error('reviewer crashed') });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.FAILED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
}));

test('a completed job with no result document is not an approval', () => withRoot((root) => {
  const { jobPath } = enqueue(root);
  completeArgusJob({ rootDir: root, jobPath, result: null });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.MALFORMED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
}));

test('an unrecognised verdict string is not an approval', () => withRoot((root) => {
  const { jobPath } = enqueue(root);
  completeArgusJob({ rootDir: root, jobPath, result: resultDoc({ verdict: 'looks-fine' }) });

  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.MALFORMED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
}));

test('a queue that cannot be read fails closed rather than approving', () => withRoot((root) => {
  const verdict = resolve(root, {
    findJob: () => {
      throw new Error('EACCES');
    },
  });

  assert.equal(verdict.state, ARGUS_VERDICT_STATES.FAILED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
}));

test('a job past the stall deadline goes red rather than pending forever', () => withRoot((root) => {
  // The 14-hour drop that produced this pack was not wrong, it was SILENT. A
  // yellow check that never resolves reproduces it exactly.
  const enqueuedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  enqueue(root, { enqueuedAt });

  const verdict = resolve(root, {
    nowMs: Date.parse(enqueuedAt) + ARGUS_REVIEW_STALL_DEADLINE_MS + 1000,
  });
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.STALLED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.satisfiesGate, false);
}));

test('an in-flight job with no valid enqueue timestamp fails closed', () => withRoot((root) => {
  for (const { bucket, enqueuedAt } of [
    { bucket: 'pending', enqueuedAt: null },
    { bucket: 'pending', enqueuedAt: '' },
    { bucket: 'inProgress', enqueuedAt: 'not-a-date' },
  ]) {
    const verdict = resolve(root, {
      findJob: () => ({
        bucket,
        jobPath: '/unused/job.json',
        job: { status: bucket === 'inProgress' ? 'in_progress' : 'pending', enqueuedAt },
      }),
    });

    assert.equal(verdict.state, ARGUS_VERDICT_STATES.MALFORMED, `${bucket}/${String(enqueuedAt)}`);
    assert.equal(verdict.blocks, true);
    assert.equal(verdict.satisfiesGate, false);
    assert.match(verdict.summary, /missing a valid enqueuedAt timestamp/u);
  }
}));

test('epoch-millisecond enqueue strings still drive stall detection', () => withRoot((root) => {
  const enqueuedAtMs = Date.UTC(2026, 0, 1);
  const findJob = () => ({
    bucket: 'pending',
    jobPath: '/unused/job.json',
    job: { status: 'pending', enqueuedAt: String(enqueuedAtMs) },
  });

  const inside = resolve(root, { findJob, nowMs: enqueuedAtMs + 60_000 });
  assert.equal(inside.state, ARGUS_VERDICT_STATES.QUEUED);
  assert.equal(inside.waitedMs, 60_000);

  const stalled = resolve(root, {
    findJob,
    nowMs: enqueuedAtMs + ARGUS_REVIEW_STALL_DEADLINE_MS + 1000,
  });
  assert.equal(stalled.state, ARGUS_VERDICT_STATES.STALLED);
  assert.equal(stalled.blocks, true);
}));

test('the stall clock runs from enqueue, not from claim', () => withRoot((root) => {
  // A job nothing ever claims is precisely the stall this watches for. A
  // claim-anchored clock would never fire for it.
  const enqueuedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  enqueue(root, { enqueuedAt });
  claimNextArgusJob({ rootDir: root, claimedAt: new Date().toISOString() });

  const verdict = resolve(root, {
    nowMs: Date.parse(enqueuedAt) + ARGUS_REVIEW_STALL_DEADLINE_MS + 1000,
  });
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.STALLED);
}));

test('a job inside the deadline reports in-flight, not stalled', () => withRoot((root) => {
  const enqueuedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  enqueue(root, { enqueuedAt });

  const queued = resolve(root, { nowMs: Date.parse(enqueuedAt) + 60_000 });
  assert.equal(queued.state, ARGUS_VERDICT_STATES.QUEUED);
  assert.equal(queued.blocks, false);
  assert.equal(queued.satisfiesGate, false);

  claimNextArgusJob({ rootDir: root, claimedAt: new Date().toISOString() });
  const inProgress = resolve(root, { nowMs: Date.parse(enqueuedAt) + 60_000 });
  assert.equal(inProgress.state, ARGUS_VERDICT_STATES.IN_PROGRESS);
  assert.equal(inProgress.satisfiesGate, false);
}));

// ---------------------------------------------------------------------------
// Head scoping: an approval is a statement about one tree.
// ---------------------------------------------------------------------------

test('an approval on one head never carries to another head', () => withRoot((root) => {
  const { jobPath } = enqueue(root, { headSha: HEAD });
  completeArgusJob({ rootDir: root, jobPath, result: resultDoc({ verdict: 'approve' }) });

  const other = resolve(root, { headSha: OTHER_HEAD });
  assert.equal(other.state, ARGUS_VERDICT_STATES.MISSING);
  assert.equal(other.satisfiesGate, false);
}));

test('a PR Argus was never asked about resolves missing and does not block', () => withRoot((root) => {
  // The ordinary case: the gate runs for every PR, and the overwhelming
  // majority fired no security trigger. `missing` must be inert.
  const verdict = resolve(root);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.MISSING);
  assert.equal(verdict.blocks, false);
  assert.equal(verdict.satisfiesGate, false);
}));

test('an identity the queue could never enqueue resolves missing, not failed', () => withRoot((root) => {
  // A short or absent head SHA is refused by ASR-03's enqueue, so no job can
  // exist under it. Reporting that as a reviewer FAILURE would turn every gate
  // run with an unresolved head into a red check.
  for (const headSha of ['', 'deadbee', null, undefined]) {
    const verdict = resolve(root, { headSha });
    assert.equal(verdict.state, ARGUS_VERDICT_STATES.MISSING, `headSha=${JSON.stringify(headSha)}`);
    assert.equal(verdict.blocks, false);
  }
}));

// ---------------------------------------------------------------------------
// Properties over the whole state space.
// ---------------------------------------------------------------------------

test('no state but approved satisfies the gate', () => {
  const states = Object.values(ARGUS_VERDICT_STATES);
  assert.ok(states.length >= 9, 'expected the full state enum');

  for (const state of states) {
    const expected = state === ARGUS_VERDICT_STATES.APPROVED;
    assert.equal(
      argusVerdictSatisfiesGate(state),
      expected,
      `${state} must ${expected ? '' : 'not '}satisfy the gate`
    );
  }
});

test('an unknown state is non-satisfying by default', () => {
  // A state added later without a decision about its authority must fall on the
  // safe side, not through a hole.
  assert.equal(argusVerdictSatisfiesGate('some-future-state'), false);
  assert.equal(argusVerdictSatisfiesGate(undefined), false);
});

test('every state has a distinct operator-facing gate reason', () => {
  const states = Object.values(ARGUS_VERDICT_STATES);
  const reasons = states.map((state) => ARGUS_GATE_REASONS[state]);

  for (const [index, reason] of reasons.entries()) {
    assert.ok(reason, `${states[index]} has no gate reason`);
  }
  assert.equal(new Set(reasons).size, states.length, 'gate reasons must not collide');
});

test('blocking and satisfying are mutually exclusive across the enum', () => {
  for (const state of Object.values(ARGUS_VERDICT_STATES)) {
    assert.ok(
      !(argusVerdictBlocksGate(state) && argusVerdictSatisfiesGate(state)),
      `${state} cannot both block and satisfy`
    );
  }
});

test('finding partition is exhaustive over the severity taxonomy', () => {
  const result = resultDoc({
    findings: [
      { severity: 'high', title: 'h' },
      { severity: 'medium', title: 'm' },
      { severity: 'low', title: 'l' },
    ],
  });

  assert.equal(blockingArgusFindings(result).length, 1);
  assert.equal(advisoryArgusFindings(result).length, 2);
  // Every finding lands in exactly one bucket: nothing is silently dropped.
  assert.equal(
    blockingArgusFindings(result).length + advisoryArgusFindings(result).length,
    result.findings.length
  );
});
