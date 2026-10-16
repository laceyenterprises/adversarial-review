import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { createDurableReviewerCandidate, createDurableReviewerRefill } from '../src/watcher-reviewer-refill.mjs';

function fixture(t, limit = 50) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  const add = (pr, overrides = {}) => {
    const row = { repo: 'example/fixture', pr_number: pr, reviewed_at: '2026-01-01',
      reviewer: 'gemini', pr_state: 'open', review_status: 'pending', revision_ref: 'head-a', ...overrides };
    db.prepare(`INSERT INTO reviewed_prs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    return db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = ?').get(pr);
  };
  const built = [];
  const refill = createDurableReviewerRefill({ db, limit, createCandidate: row => {
    built.push(row.pr_number);
    return { repoPath: row.repo, prNumber: row.pr_number };
  } });
  return { db, add, built, ...refill };
}

test('durable refill bounds reads, advances past refused rows and wraps without GitHub work', t => {
  const f = fixture(t, 2);
  for (let pr = 1; pr <= 5; pr++) f.add(pr);
  f.onSettled({ repoPath: 'example/fixture', prNumber: 1 });
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [2]);
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [3, 4]);
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [5]);
  assert.deepEqual(f.refill([{ repoPath: 'example/fixture', prNumber: 2 }]), []);
});

test('durable refill excludes held, closed, claimed and unrequested posted rows', t => {
  const f = fixture(t);
  f.add(1, { labels_json: '["no-merge-hold"]' });
  f.add(2, { labels_json: '[{"name":"do-not-merge"}]' });
  f.add(3, { pr_state: 'closed' });
  f.add(4, { review_status: 'reviewing' });
  f.add(5, { posted_at: '2026-01-01' });
  f.add(6, { posted_at: '2026-01-01', rereview_requested_at: '2026-01-02' });
  f.add(7, { review_status: 'pending-upstream' });
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [6, 7]);
});

function candidateFixture(overrides = {}) {
  const row = { repo: 'example/fixture', pr_number: 1, reviewer: 'gemini', revision_ref: 'head-a' };
  let reads = 0, processes = 0, runs = 0, admissions = 0, releases = 0;
  const enqueued = [];
  const context = { domainId: 'code-pr', pipelineGeminiSeats: 1, supportsAdmissionSplit: true,
    hasPriorPostedReview: () => false };
  const candidate = createDurableReviewerCandidate(row, {
    context,
    subjectAdapter: { async fetchState() {
      reads++;
      return { headSha: 'head-a', labels: [], ...overrides.subject };
    } },
    async processSubject(entry, ctx) {
      processes++;
      assert.equal(entry.current, undefined, 'discovery re-reads the current durable row');
      ctx.enqueueReviewerDispatchCandidate({ reviewerModel: overrides.route || 'gemini',
        async run() { runs++; this.markAdmissionStarted(); this.admissionReleaseCapacity?.(); } });
    },
    enqueue: candidate => enqueued.push(candidate),
  });
  candidate.markAdmissionStarted = () => admissions++;
  candidate.admissionReleaseCapacity = () => releases++;
  return { candidate, enqueued, counts: () => ({ reads, processes, runs, admissions, releases }) };
}

test('durable candidate defers API/discovery until pool admission and preserves admission split', async () => {
  const f = candidateFixture();
  assert.deepEqual(f.counts(), { reads: 0, processes: 0, runs: 0, admissions: 0, releases: 0 });
  await f.candidate.run();
  assert.deepEqual(f.counts(), { reads: 1, processes: 1, runs: 1, admissions: 1, releases: 1 });
});

for (const subject of [{ terminal: true }, { headSha: 'head-b' }, { labels: ['merge-agent-skip'] }, { labelsKnown: false }]) {
  test(`durable candidate refuses changed or held subject ${JSON.stringify(subject)}`, async () => {
    const f = candidateFixture({ subject });
    assert.equal((await f.candidate.run()).dispatched, false);
    assert.equal(f.counts().runs, 0);
    assert.equal(f.counts().processes, 0);
  });
}

test('durable candidate requeues a changed credential route instead of using the old reservation', async () => {
  const f = candidateFixture({ route: 'codex' });
  assert.equal((await f.candidate.run()).reason, 'durable-refill-route-changed');
  assert.equal(f.counts().runs, 0);
  assert.equal(f.enqueued[0].reviewerModel, 'codex');
});


test('settling an obsolete candidate does not suppress an already observed newer head', t => {
  const f = fixture(t);
  f.add(1, { revision_ref: 'head-b' });
  f.onSettled({ repoPath: 'example/fixture', prNumber: 1, subject: { headSha: 'head-a' } });
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [1]);
});
