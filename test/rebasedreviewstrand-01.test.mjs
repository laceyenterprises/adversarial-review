// REBASEDREVIEWSTRAND-01: a PR rebased in place after its review failed and
// parked must be admitted for review on the new head. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
import { createDetachedReviewerDispatchTracker } from '../src/watcher-reviewer-pool.mjs';
import { recoverOverdueOwnership } from '../src/ownerproof-review-recovery.mjs';
import { createDurableHeadRebinder, createDurableReviewerCandidate, createDurableReviewerRefill } from '../src/watcher-reviewer-refill.mjs';

const REPO = 'example/fixture';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };

function fixture(t, rowOverrides = {}) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  const row = { repo: REPO, pr_number: 1, reviewed_at: '2026-01-01T00:00:00Z', reviewer: 'gemini',
    pr_state: 'open', review_status: 'pending', revision_ref: HEAD_A,
    rereview_requested_at: '2026-01-02T00:00:00Z', ...rowOverrides };
  db.prepare(`INSERT INTO reviewed_prs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  const read = () => db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 1').get();
  const logs = [];
  const rebindHead = createDurableHeadRebinder(db, { logger: { log: line => logs.push(line) } });
  const spawned = [];
  const build = (live, current = read()) => createDurableReviewerCandidate(current, {
    context: { domainId: 'code-pr', hasPriorPostedReview: () => false },
    subjectAdapter: { async fetchState() { return { labels: [], ...live }; } },
    async processSubject(entry, ctx) {
      ctx.enqueueReviewerDispatchCandidate({ reviewerModel: 'gemini', async run() {
        spawned.push(entry.subject.headSha, read().revision_ref);
        return { dispatched: true };
      } });
    },
    enqueue() { assert.fail('route is unchanged'); },
    rebindHead,
  });
  return { db, read, logs, spawned, build };
}

test('failed and parked at A, rebased to B: the queued re-review is admitted for B', async t => {
  const f = fixture(t, { review_status: 'failed', failure_message: '[reviewer-stalled] no output' });
  // The operator retrigger resets the row to pending; its head can lag the rebase.
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'pending' WHERE pr_number = 1").run();
  const result = await f.build({ headSha: HEAD_B }).run();
  assert.deepEqual(result, { dispatched: true });
  assert.deepEqual(f.spawned, [HEAD_B, HEAD_B]);
  assert.equal(f.read().revision_ref, HEAD_B);
  assert.equal(f.read().rereview_requested_at, '2026-01-02T00:00:00Z', 'the request keeps its priority');
  assert.match(f.logs.join('\n'), /REBASEDREVIEWSTRAND-01: superseded durable re-review example\/fixture#1 from=a+ to=b+/);
});

test('exact-head retrigger for B after a startup durable entry for A is admitted', async t => {
  const f = fixture(t);
  const refill = createDurableReviewerRefill({ db: f.db, createCandidate: row => f.build({ headSha: HEAD_B }, row) });
  const [startup] = refill.refill([]);
  refill.onSettled({ ...startup, subject: startup.subject });
  // Startup entry for A is refused as ineligible and settles; nothing is offered again.
  assert.deepEqual(refill.refill([]), []);
  f.db.prepare(`UPDATE reviewed_prs SET revision_ref = ?, rereview_requested_at = '2026-01-03T00:00:00Z'
    WHERE pr_number = 1`).run(HEAD_B.slice(0, 8));
  const [retriggered] = refill.refill([]);
  assert.ok(retriggered, 'the retrigger changes durable state and re-arms refill');
  assert.deepEqual(await retriggered.run(), { dispatched: true });
  assert.equal(f.read().revision_ref, HEAD_B, 'an abbreviated retrigger head is rebound to the full live head');
});

for (const live of [{ terminal: true, headSha: HEAD_B }, { headSha: HEAD_B, labelsKnown: false },
  { headSha: HEAD_B, labels: ['merge-agent-skip'] }]) {
  test(`a terminal, held or unreadable subject is still refused, not rebound ${JSON.stringify(live)}`, async t => {
    const f = fixture(t);
    assert.equal((await f.build(live).run()).reason, 'durable-refill-subject-changed');
    assert.equal(f.read().revision_ref, HEAD_A);
    assert.deepEqual(f.spawned, []);
  });
}

test('a row claimed or moved concurrently is not rebound', async t => {
  const f = fixture(t);
  const candidate = f.build({ headSha: HEAD_B });
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing' WHERE pr_number = 1").run();
  assert.equal((await candidate.run()).reason, 'durable-refill-subject-changed');
  assert.equal(f.read().revision_ref, HEAD_A);
});

test('closure-park custody at A does not affect B, and an unrelated PR keeps its custody', async () => {
  const overdue = head => ({ headSha: head, nextAction: { head, row: 'R04', action: 'hammer', actor: 'hammer',
    deadline: { at: '2026-01-01T00:00:00Z' } } });
  const recovered = [];
  const args = (prNumber, headSha) => ({ rootDir: '/nonexistent', repo: REPO, prNumber, enabled: true,
    now: '2026-02-01T00:00:00Z', subject: { headSha, labels: [] }, reviewStateRow: { review_status: 'failed' },
    logger: quiet, readLaneImpl: () => overdue(HEAD_A),
    recoverImpl: async input => { recovered.push([input.prNumber, input.headSha]); return { outcome: 'recovery-exhausted' }; } });
  assert.equal(await recoverOverdueOwnership(args(1, HEAD_B)), null);
  assert.deepEqual(recovered, [], 'old-head custody is inert for the new head');
  await recoverOverdueOwnership(args(2, HEAD_A));
  assert.deepEqual(recovered, [[2, HEAD_A]], 'custody for an unrelated PR at its own head is unchanged');
});

test('a pending re-review refused before admission logs its filter reason without wait pressure', async () => {
  const logs = [];
  const recent = new Date().toISOString();
  const queue = [{ repoPath: REPO, prNumber: 1, reviewerModel: 'gemini', current: { rereview_requested_at: recent },
    run: async () => ({ dispatched: false, reason: 'durable-refill-subject-changed' }) }];
  const drain = createReviewerDispatchDrain({
    reviewerPoolConfig: { enabled: true, maxConcurrent: 3 }, reviewerDispatchCandidates: queue,
    readWatcherDrainState: () => ({ active: false }),
    detachedReviewerDispatchTracker: createDetachedReviewerDispatchTracker({ logger: quiet }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    prepareSpillover: async candidates => candidates, singleWaveSettleGraceMs: 0,
    logger: { log: line => logs.push(line), warn() {}, error() {} },
    runQueue: async (candidates, { onCandidateStarted }) => {
      onCandidateStarted({ candidate: candidates[0], promise: candidates[0].run() });
      return { dispatched: 0, deferred: 0 };
    },
  });
  await drain('poll');
  const waitLogs = logs.filter(line => line.includes('review-wait-decision'));
  assert.equal(waitLogs.length, 1);
  assert.match(waitLogs[0], /pr=1 .*decision=durable-refill-subject-changed/);
});
