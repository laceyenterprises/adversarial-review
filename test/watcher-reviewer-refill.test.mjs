import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewWaitPressure } from '../src/review-queue-depth.mjs';
import { reviewerSafetyPassKind } from '../src/watcher-reviewer-pool.mjs';
import { ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { attachDurableReviewerRefill, createDurableReviewerCandidate, createDurableReviewerRefill } from '../src/watcher-reviewer-refill.mjs';
import { recoverOverdueOwnership } from '../src/ownerproof-review-recovery.mjs';
import { readNoProgressLane, recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { createHeadDispatchLease, headDispatchLeaseKey } from '../src/reviewed-head-dispatch-gate.mjs';

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
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [2, 3]);
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [4, 5]);
  assert.deepEqual(f.refill([{ repoPath: 'example/fixture', prNumber: 2 }]).map(c => c.prNumber), [3]);
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

test('unassigned rows cannot consume the bounded refill page', t => {
  const f = fixture(t, 2);
  f.add(1, { reviewer: '' });
  f.add(2, { reviewer: '' });
  f.add(3);
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [3]);
});

for (const transition of [
  "UPDATE reviewed_prs SET pr_state = 'closed' WHERE pr_number = 1",
  "UPDATE reviewed_prs SET pr_state = 'merged' WHERE pr_number = 1",
  "UPDATE reviewed_prs SET review_status = 'posted' WHERE pr_number = 1",
  'DELETE FROM reviewed_prs WHERE pr_number = 1',
]) {
  test(`refill forgets inactive settled rows without another settlement: ${transition}`, t => {
    const f = fixture(t);
    f.add(1);
    f.add(2, { review_status: 'pending-upstream' });
    for (const prNumber of [1, 2]) f.onSettled({ repoPath: 'example/fixture', prNumber });
    assert.deepEqual(f.refill([]), []);
    f.db.prepare(transition).run();
    assert.deepEqual(f.refill([]), []);
    // Restore the exact refused state. Admission now proves its old snapshot
    // was discarded, while the still-pending row remains suppressed.
    f.db.prepare('DELETE FROM reviewed_prs WHERE pr_number = 1').run();
    f.add(1);
    assert.deepEqual(f.refill([]).map(c => c.prNumber), [1]);
  });
}

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

test('durable candidate retains ledger age for the separate re-review wait bound before discovery', () => {
  const nowMs = Date.parse('2026-10-17T10:00:00Z');
  for (const ageSeconds of [600, 900, 901]) {
    const candidate = createDurableReviewerCandidate({
      repo: 'example/fixture', pr_number: 1, reviewer: 'gemini', revision_ref: 'head-a',
      posted_at: '2026-10-16T10:00:00Z',
      rereview_requested_at: new Date(nowMs - ageSeconds * 1000).toISOString(),
    }, {
      context: { hasPriorPostedReview: () => true },
      subjectAdapter: { fetchState() { assert.fail('wait classification must not fetch GitHub state'); } },
      processSubject() { assert.fail('wait classification must not run discovery'); },
      enqueue() { assert.fail('wait classification must not enqueue another route'); },
    });
    const pressure = reviewWaitPressure({ ...candidate, depthPassKind: reviewerSafetyPassKind(candidate) }, {
      nowMs, env: { ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS: '900' },
    });
    assert.equal(pressure.waitSeconds, ageSeconds);
    assert.equal(pressure.engaged, ageSeconds > 900);
  }
});

test('durable candidate forwards spawn timing and the post timestamp before releasing capacity', async () => {
  const events = [];
  const postedAt = Date.parse('2026-10-16T10:00:00Z');
  const candidate = createDurableReviewerCandidate({
    repo: 'example/fixture', pr_number: 1, reviewer: 'gemini', revision_ref: 'head-a',
  }, {
    context: { hasPriorPostedReview: () => false },
    subjectAdapter: { async fetchState() { return { headSha: 'head-a', labels: [] }; } },
    async processSubject(_entry, context) {
      context.enqueueReviewerDispatchCandidate({ reviewerModel: 'gemini', async run() {
        this.markAdmissionStarted();
        this.markReviewerSpawned?.();
        this.durablePostedAt = postedAt;
        this.admissionReleaseCapacity?.({ dispatched: true });
      } });
    },
    enqueue() { assert.fail('unchanged route should retain its reservation'); },
  });
  candidate.markAdmissionStarted = () => events.push('admitted');
  candidate.markReviewerSpawned = () => events.push('spawned');
  candidate.admissionReleaseCapacity = result => events.push(['released', candidate.durablePostedAt, result]);
  await candidate.run();
  assert.deepEqual(events, ['admitted', 'spawned', ['released', postedAt, { dispatched: true }]]);
});

for (const fails of [false, true]) {
  test(`durable candidate preserves the posted timestamp without admission split (fails=${fails})`, async () => {
    const postedAt = Date.parse('2026-10-16T10:00:00Z');
    const candidate = createDurableReviewerCandidate({
      repo: 'example/fixture', pr_number: 1, reviewer: 'gemini', revision_ref: 'head-a',
    }, {
      context: { supportsAdmissionSplit: false, hasPriorPostedReview: () => false },
      subjectAdapter: { async fetchState() { return { headSha: 'head-a', labels: [] }; } },
      async processSubject(_entry, context) {
        context.enqueueReviewerDispatchCandidate({ reviewerModel: 'gemini', async run() {
          await Promise.resolve();
          this.durablePostedAt = postedAt;
          if (fails) throw new Error('post bookkeeping failed');
          return { dispatched: true };
        } });
      },
      enqueue() { assert.fail('unchanged route should retain its reservation'); },
    });
    assert.equal(candidate.supportsAdmissionSplit, false);
    if (fails) await assert.rejects(candidate.run(), /post bookkeeping failed/);
    else assert.deepEqual(await candidate.run(), { dispatched: true });
    assert.equal(candidate.durablePostedAt, postedAt);
  });
}

for (const subject of [{ terminal: true }, { labels: ['merge-agent-skip'] }, { labelsKnown: false }]) {
  test(`durable candidate refuses changed or held subject ${JSON.stringify(subject)}`, async () => {
    const f = candidateFixture({ subject });
    assert.equal((await f.candidate.run()).dispatched, false);
    assert.equal(f.counts().runs, 0);
    assert.equal(f.counts().processes, 0);
  });
}

for (const requestedAtStartup of [false, true]) test(`a stale startup candidate admits the current head after an operator retrigger (prior request=${requestedAtStartup})`, async t => {
  const f = fixture(t);
  const rootDir = mkdtempSync(join(tmpdir(), 'durable-refill-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/fixture', prNumber: 1 };
  const unrelated = { ...identity, prNumber: 2 };
  const leases = createHeadDispatchLease();
  const leaseKey = headSha => headDispatchLeaseKey({ repoPath: identity.repo, prNumber: identity.prNumber, headSha });
  leases.tryAcquire(leaseKey('head-a'));
  for (const pr of [identity, unrelated]) {
    recordNoProgressLaneRun(rootDir, pr, { headSha: 'head-a', fingerprint: 'parked',
      nextAction: { head: 'head-a', row: 'R04-ownership', action: 'reconcile', actor: 'operator',
        deadline: { at: '2026-01-01T00:00:00Z' } } });
  }
  const unrelatedBefore = readNoProgressLane(rootDir, unrelated);
  const audit = [];
  f.add(1, { review_status: 'failed', reviewer_head_sha: 'head-a', infra_auto_recover_attempts: 3 });
  const retrigger = head => requestReviewRereview({ rootDir, db: f.db, repo: 'example/fixture', prNumber: 1,
    targetRevisionRef: head, reason: 'retrigger-review: synthetic exact-head request' });
  const { reviewRow } = retrigger('head-a');
  if (!requestedAtStartup) reviewRow.rereview_requested_at = null;
  const dispatched = [];
  const candidate = createDurableReviewerCandidate(reviewRow, {
    context: { hasPriorPostedReview: () => false },
    readCurrent: () => f.db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 1').get(),
    subjectAdapter: { async fetchState(_ref, options) {
      assert.equal(options.fresh, true);
      return { headSha: 'head-b', labels: [] };
    } },
    async processSubject({ subject }, context) {
      const recovery = await recoverOverdueOwnership({ rootDir, ...identity, subject, enabled: true,
        recoverImpl: () => assert.fail('superseded custody cannot execute recovery'),
        logger: { log: line => audit.push(line) } });
      assert.equal(recovery, null);
      assert.equal(f.db.prepare('SELECT revision_ref FROM reviewed_prs').pluck().get(), subject.headSha);
      context.enqueueReviewerDispatchCandidate({ reviewerModel: 'gemini', async run() {
        assert.equal(leases.tryAcquire(leaseKey(subject.headSha)), true);
        dispatched.push(subject.headSha);
        return { dispatched: true };
      } });
    },
    enqueue() { assert.fail('unchanged route should retain its reservation'); },
  });
  assert.equal(retrigger('head-b').reviewRow.revision_ref, 'head-b');
  const result = await candidate.run();
  assert.deepEqual(dispatched, ['head-b'], JSON.stringify(result));
  assert.equal(readNoProgressLane(rootDir, identity), null);
  assert.deepEqual(readNoProgressLane(rootDir, unrelated), unrelatedBefore);
  assert.match(audit[0], /previous_head=head-a head=head-b state=parked-ownership-and-deadline/);
});

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

test('refill offers the new head when the old head is still waiting in the pool', t => {
  const f = fixture(t);
  f.add(1, { revision_ref: 'head-b' });
  const queued = { repoPath: 'example/fixture', prNumber: 1, subject: { headSha: 'head-a' } };
  assert.deepEqual(f.refill([queued]).map(c => c.prNumber), [1]);
  assert.deepEqual(f.refill([{ ...queued, subject: { headSha: 'head-b' } }]), []);
});


test('unchanged settled rows cannot consume the bounded page ahead of admissible work', t => {
  const f = fixture(t, 2);
  for (let pr = 1; pr <= 4; pr++) f.add(pr);
  for (let pr = 1; pr <= 3; pr++) f.onSettled({ repoPath: 'example/fixture', prNumber: pr });
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [4]);
  f.db.prepare("UPDATE reviewed_prs SET rereview_requested_at = '2026-01-02' WHERE pr_number = 1").run();
  assert.deepEqual(f.refill([]).map(c => c.prNumber), [1, 4]);
});

test('refill scopes the database page before its bound, excluding rows without an enabled discovery context', t => {
  const f = fixture(t, 2);
  f.add(1, { repo: 'example/disabled' });
  f.add(2, { repo: 'example/disabled' });
  f.add(3);
  const scoped = createDurableReviewerRefill({ db: f.db, limit: 2,
    scope: () => ['code-pr:example/fixture'], createCandidate: row => ({ prNumber: row.pr_number }) });
  assert.deepEqual(scoped.refill([]).map(c => c.prNumber), [3]);
});

test('startup refill defers durable work until discovery registers its repo context', t => {
  const f = fixture(t);
  f.add(1);
  const contexts = new Map();
  let refill;
  let scopeReads = 0;
  attachDurableReviewerRefill({ db: f.db, contexts,
    admission: { setRefill: impl => { refill = impl; }, enqueue() {} },
    processSubject() { assert.fail('refill must defer discovery until admission'); },
    readScope: () => {
      scopeReads++;
      return { repos: ['example/fixture'], domains: ['code-pr'], primaryDomainId: 'code-pr' };
    },
  });
  assert.equal(scopeReads, 0, 'attachment must not read scope before watcher initialization');
  assert.deepEqual(refill([]), []);
  contexts.set('code-pr:example/fixture', {
    subjectAdapter: { fetchState() { assert.fail('refill must defer API work until admission'); } },
    context: { domainId: 'code-pr', hasPriorPostedReview: () => false },
  });
  assert.deepEqual(refill([]).map(c => c.prNumber), [1]);
});

test('attached refill uses the configured primary domain for legacy null-domain rows', t => {
  const f = fixture(t);
  f.add(1);
  f.add(2, { domain_id: 'research-finding' });
  f.add(3, { domain_id: 'code-pr' });
  const contexts = new Map([['research-finding:example/fixture', {
    subjectAdapter: { fetchState() { assert.fail('refill must defer API work until admission'); } },
    context: { domainId: 'research-finding', hasPriorPostedReview: () => false },
  }]]);
  let refill;
  attachDurableReviewerRefill({ db: f.db, contexts,
    admission: { setRefill: impl => { refill = impl; }, enqueue() {} },
    processSubject() { assert.fail('refill must defer discovery until admission'); },
    readScope: () => ({ repos: ['example/fixture'], domains: ['research-finding'], primaryDomainId: 'research-finding' }),
  });
  assert.deepEqual(refill([]).map(c => c.prNumber), [1, 2]);
  assert.deepEqual(refill([]).map(c => c.prNumber), [1, 2], 'cursor wrap retains the primary-domain scope');
});
