import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverOwnerlessReview, recoverOverdueOwnership } from '../src/ownerproof-review-recovery.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const args = { rootDir: '/fixture', repo: 'example/repo', prNumber: 8085,
    reviewStateRow: { review_status: 'pending', revision_ref: 'old', review_attempts: 100 }, enabled: true,
    fetchCandidateImpl: async () => ({ prState: 'open', headSha: 'live', labels: [] }),
    fetchReviewsImpl: async () => [],
    recoverImpl: async input => { calls.push(input); return { outcome: 'ama-pending' }; }, ...overrides };
  return { calls, args };
}
test('spent pending review reaches watchdog before retry admission', async () => {
  const { calls, args } = fixture();
  await recoverOwnerlessReview(args);
  assert.equal(calls.length, 1); assert.equal(calls[0].headSha, 'live');
  assert.equal(calls[0].result.ownerProofFacts.reviewedHeadSha, null);
});
for (const prState of ['closed', 'merged']) test(`live ${prState} cancels stale pending recovery`, async () => {
  const { calls, args } = fixture({ fetchCandidateImpl: async () => ({ headSha: 'live', prState }) });
  await recoverOwnerlessReview(args); assert.equal(calls.length, 0);
});
test('posted rows use closure watchdog and disabled authority does not add reads', async () => {
  for (const overrides of [{ enabled: false }, { reviewStateRow: { review_status: 'posted' } }]) {
    const { args, calls } = fixture({ ...overrides, fetchCandidateImpl: () => assert.fail('no extra read') });
    await recoverOwnerlessReview(args); assert.equal(calls.length, 0);
  }
});
test('current-head review and live conflict/check state reach the watchdog', async () => {
  const { args, calls } = fixture({
    fetchCandidateImpl: async () => ({ headSha: 'live', prState: 'open', labels: [], mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
    fetchReviewsImpl: async () => ['## Verdict\nComment only'],
  });
  await recoverOwnerlessReview(args);
  assert.equal(calls[0].result.ownerProofFacts.verdict, 'comment-only');
  assert.equal(calls[0].result.ownerProofFacts.mergeable, 'CONFLICTING');
});

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordNoProgressLaneRun, evaluateNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import { recoverOrphan } from '../src/ama/orphan-watchdog.mjs';

const deadlineDecision = { head: 'live', row: 'R08-retry', action: 'hammer', actor: 'hammer', reason: 'retry-no-merge',
  queue: { intent: 'dispatch' }, deadline: { at: '2026-10-27T10:00:00Z' } };

test('OWNERDEADLINE-01: a slow-lane PR recovers before full-walk admission using local evidence', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'deadline-lane-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/repo', prNumber: 8085 };
  // Legacy lane records lack a shared action; the shared refresh deadline
  // still bounds their wait and names the missing transition.
  recordNoProgressLaneRun(rootDir, identity, { headSha: 'live', fingerprint: 'unchanged' });
  const dir = join(rootDir, 'data', 'watcher-no-progress-lane');
  const { noProgressLaneFilePath } = await import('../src/watcher-no-progress-lane.mjs');
  const path = noProgressLaneFilePath(rootDir, identity);
  const lane = { ...identity, headSha: 'live', noProgressTicks: 20, skippedTicks: 0,
    progressClass: 'self-resolving', firstNoProgressAt: '2026-10-27T10:00:00Z' };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(lane));
  assert.equal(evaluateNoProgressLane(lane, { headSha: 'live' }).due, false);
  let pages = 0;
  let candidateReads = 0;
  const options = { rootDir, ...identity, enabled: true,
    subject: { headSha: 'live', labels: [] }, reviewStateRow: { review_status: 'posted' },
    now: '2026-10-27T10:30:00Z', env: { OWNERPROOF_IDLE_MINUTES: '15' },
    recoverImpl: input => recoverOrphan({ ...input, hasOwnerImpl: async () => ({ owned: false }),
      pageImpl: async () => { pages++; return { queued: true }; }, logger: { log() {}, info() {}, warn() {} } }),
    fetchCandidateImpl: () => { candidateReads++; assert.fail('deadline check cannot read GitHub'); } };
  await recoverOverdueOwnership(options);
  await recoverOverdueOwnership(options);
  assert.equal(pages, 1);
  assert.equal(candidateReads, 0);
  // The same independent pass dispatches an executable selected successor.
  writeFileSync(path, JSON.stringify({ ...lane, nextAction: deadlineDecision }));
  let dispatched = 0;
  const result = await recoverOverdueOwnership({ ...options,
    fetchCandidateImpl: async () => ({ headSha: 'live', prState: 'open', labels: [] }),
    dispatchImpl: async () => { dispatched++; return { dispatched: true }; } });
  assert.equal(result.outcome, 'ama-dispatched');
  assert.equal(dispatched, 1);
});

for (const scenario of ['fresh', 'old-head', 'terminal', 'disabled', 'draft']) test(`OWNERDEADLINE-01: ${scenario} deadline check is local and inactive`, async () => {
  await recoverOverdueOwnership({ rootDir: '/fixture', repo: 'example/repo', prNumber: 1,
    enabled: scenario !== 'disabled', now: '2026-10-27T10:30:00Z',
    subject: { headSha: 'live', terminal: scenario === 'terminal', isDraft: scenario === 'draft', labels: [] },
    readLaneImpl: () => ({ headSha: 'live', nextAction: { ...deadlineDecision,
      head: scenario === 'old-head' ? 'old' : 'live',
      deadline: { at: scenario === 'fresh' ? '2026-10-27T10:29:00Z' : deadlineDecision.deadline.at } } }),
    fetchCandidateImpl: () => assert.fail('no GitHub read'), recoverImpl: () => assert.fail('no recovery') });
});
