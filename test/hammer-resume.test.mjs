import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAmaAuditEntry, readAmaAuditEntry, appendAmaAuditAttempt, amaAuditFilePath } from '../src/ama/audit.mjs';
import { readHammerResumes, reconcileHammerResumes, settleHammerResume } from '../src/ama/hammer-resume.mjs';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import { recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { getStalePostedReviewAutoRereviewSuppression } from '../src/stale-posted-review-rereview.mjs';

const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const identity = { repo: 'example/project', prNumber: 17, headSha: HEAD };
const quiet = { log() {}, warn() {} };
function fixture(t) {
  const hqRoot = mkdtempSync(join(tmpdir(), 'hammer-resume-'));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const args = { hqRoot, ...identity };
  writeAmaAuditEntry({ ...args, attempt: { outcome: 'deferred', reason: 'required-checks-pending',
    attemptPhase: 'hammer-gh-pr-merge', resumeOwed: true, resumeHead: HEAD } });
  return args;
}

for (const [name, state, head, checks, reason] of [
  ['head movement', 'OPEN', OTHER, 'SUCCESS', 'head-moved'],
  ['red checks', 'OPEN', HEAD, 'FAILURE', 'checks-red'],
  ['cancelled checks', 'OPEN', HEAD, 'CANCELLED', 'checks-red'],
  ['timed out checks', 'OPEN', HEAD, 'TIMED_OUT', 'checks-red'],
  ['merged', 'MERGED', HEAD, 'SUCCESS', 'pr-terminal'],
  ['closed', 'CLOSED', HEAD, 'SUCCESS', 'pr-terminal'],
]) test(`HAMRESUMEOWED-01: ${name} closes the old debt explicitly and idempotently`, t => {
  const args = fixture(t);
  for (let i = 0; i < 2; i++) assert.equal(reconcileHammerResumes({ ...args, prState: state, headSha: head, checks }), null);
  const attempts = readAmaAuditEntry(args.hqRoot, args.repo, args.prNumber, HEAD).attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].reason, `resume-${reason}`);
  assert.equal(attempts[1].resumeOwed, false);
  assert.equal(attempts[1].resumeAttempt, 1);
  assert.deepEqual(readHammerResumes(args), []);
});

test('HAMRESUMEOWED-01: dispatch acknowledgement settles only its own receipt once', t => {
  const args = fixture(t);
  const resume = readHammerResumes(args)[0];
  for (let i = 0; i < 2; i++) settleHammerResume({ ...args, resume, reason: 'dispatched', launchRequestId: 'synthetic-launch' });
  assert.equal(readAmaAuditEntry(args.hqRoot, args.repo, args.prNumber, HEAD).attempts.length, 2);
  appendAmaAuditAttempt({ ...args, attempt: { outcome: 'deferred', reason: 'required-checks-pending',
    resumeOwed: true, resumeHead: HEAD } });
  assert.equal(readHammerResumes(args)[0].attemptNumber, 3, 'a later bounded wait incurs a new debt');
});

test('HAMRESUMEOWED-01: a later real helper refusal cannot revive the pending debt', t => {
  const args = fixture(t);
  appendAmaAuditAttempt({ ...args, attempt: { outcome: 'failed-without-merge',
    attemptPhase: 'hammer-gh-pr-merge', reason: 'github-gate-red' } });
  assert.deepEqual(readHammerResumes(args), []);
});

test('HAMRESUMEOWED-01: outstanding debt bypasses scheduler backoff and stale automatic rereview', async t => {
  const args = fixture(t), rootDir = args.hqRoot;
  for (let i = 0; i < 10; i++) recordNoProgressLaneRun(rootDir, identity, {
    headSha: HEAD, fingerprint: 'unchanged', logger: quiet });
  const gate = createNoProgressLaneGate({ rootDir, hqRoot: args.hqRoot, readReviewRow: () => null, logger: quiet });
  const handler = { repoPath: args.repo, prNumber: args.prNumber, headSha: HEAD };
  assert.equal(gate.evaluate(handler).run, true);
  assert.equal(gate.evaluate(handler).reason, 'hammer-resume-owed');
  const suppression = await getStalePostedReviewAutoRereviewSuppression({ ...handler,
    currentHeadSha: HEAD, rootDir, env: { HQ_ROOT: args.hqRoot } });
  assert.equal(suppression.suppressed, true);
  assert.equal(suppression.reason, 'hammer-resume-owed');
  assert.equal((await getStalePostedReviewAutoRereviewSuppression({ ...handler,
    currentHeadSha: OTHER, rootDir, env: { HQ_ROOT: args.hqRoot } })).suppressed, false);
});

test('HAMRESUMEOWED-01: resume bookkeeping cannot clear a real deterministic refusal', async t => {
  const args = fixture(t);
  appendAmaAuditAttempt({ ...args, attempt: { outcome: 'failed-without-merge',
    attemptPhase: 'hammer-gh-pr-merge', reason: 'primary-change-reverted' } });
  appendAmaAuditAttempt({ ...args, attempt: { outcome: 'deferred', attemptPhase: 'hammer-gh-pr-merge',
    reason: 'required-checks-pending', resumeOwed: true, resumeHead: HEAD } });
  reconcileHammerResumes({ ...args, prState: 'OPEN', checks: 'FAILURE' });
  const { readHammerStopForHead } = await import('../src/ama/hammer-stop-hold.mjs');
  assert.equal(readHammerStopForHead(args).predicate, 'primary-change-reverted');
});

test('HAMRESUMEOWED-01: read-only closure probes leave stale receipts unchanged', t => {
  const args = fixture(t);
  assert.equal(reconcileHammerResumes({ ...args, headSha: OTHER, prState: 'OPEN', checks: 'SUCCESS', readOnly: true }), null);
  assert.equal(readHammerResumes(args).length, 1);
  assert.equal(readAmaAuditEntry(args.hqRoot, args.repo, args.prNumber, HEAD).attempts.length, 1);
});


test('HAMRESUMEOWED-01: damaged audit cannot abort scheduling other PRs or authorize closure', t => {
  const args = fixture(t), rootDir = args.hqRoot;
  writeFileSync(amaAuditFilePath(args.hqRoot, args.repo, args.prNumber, HEAD), 'invalid JSON');
  const gate = createNoProgressLaneGate({ rootDir, hqRoot: args.hqRoot, readReviewRow: () => null, logger: quiet });
  assert.equal(gate.evaluate({ repoPath: args.repo, prNumber: args.prNumber, headSha: HEAD }).run, true);
  assert.doesNotThrow(() => gate.evaluate({ repoPath: 'example/other', prNumber: 18, headSha: HEAD }));
  assert.throws(() => reconcileHammerResumes({ ...args, prState: 'OPEN', checks: 'SUCCESS' }));
});
