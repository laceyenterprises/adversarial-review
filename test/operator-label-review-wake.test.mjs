import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { observeOperatorLabelReviewWake } from '../src/operator-label-review-wake.mjs';
import { readFollowUpOperatorLabel, operatorLabelSatisfiesStop } from '../src/follow-up-operator-label.mjs';
import { pendingExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { buildFollowUpJob, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';
import { recordNoProgressLaneRun, readNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import { applyLivePackCrossEditFindings } from '../src/live-pack-cross-edit.mjs';

const repo = 'example/review-fixture', prNumber = 17, headSha = 'a'.repeat(40);
const before = '2026-01-01T10:00:00Z', appliedAt = '2026-01-01T11:00:00Z', now = '2026-01-01T12:00:00Z';
const label = 'live-pack-edit-approved';
const logger = { log() {}, warn() {} };
const body = applyLivePackCrossEditFindings('## Blocking issues\n- None.\n\n## Verdict\nApproved', [{
  kind: 'live_pack_cross_edit', pack: 'sample-pack', runs: [{ run_id: 'sample-run', state: 'running' }],
  run_ids: ['sample-run'], touched_files: ['projects/sample-pack/prompts/sample.md'], inconclusive: false,
}]);
function fixture(t, reviewBody = body) {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-review-wake-'));
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, reviewed_at, reviewer, review_status, pr_state,
    revision_ref, reviewer_head_sha, posted_at) VALUES (?, ?, ?, 'codex', 'posted', 'open', ?, ?, ?)`)
    .run(repo, prNumber, before, headSha, headSha, before);
  db.prepare(`INSERT INTO reviewer_passes(repo, pr_number, attempt_number, reviewer_class, pass_kind,
    started_at, ended_at, status, head_sha, body_md, body_captured_at, verdict, gh_comment_id)
    VALUES (?, ?, 1, 'codex', 'first-pass', ?, ?, 'posted', ?, ?, ?, 'request-changes', 'review-1')`)
    .run(repo, prNumber, before, before, headSha, reviewBody, before);
  let present = true;
  let event = { event: 'labeled', id: 7, label: { name: label }, actor: { login: 'fixture-operator' }, created_at: appliedAt };
  const read = identity => readFollowUpOperatorLabel(identity, {
    execFileSyncImpl: (_file, args) => JSON.stringify(args.includes('--slurp') ? [[event]]
      : { head: { sha: headSha }, labels: present ? [{ name: label }] : [] }),
  });
  const args = { rootDir, db, repo, prNumber, headSha, logger, now: () => now, readOperatorLabelImpl: read };
  return { rootDir, db, args, read, remove() { present = false; }, event(value) { event = { ...event, ...value }; },
    wake(overrides = {}) { return observeOperatorLabelReviewWake({ ...args, ...overrides }); },
    intent() { return pendingExplicitReviewIntent(db, { repo, prNumber, headSha, now }); } };
}

test('LABELREARM-01: gated posted review with no job arms one exact-head waiver observation and exits lane', t => {
  const f = fixture(t);
  recordNoProgressLaneRun(f.rootDir, { repo, prNumber }, { headSha, fingerprint: 'operator-blocked', progressClass: 'operator-decision-required', logger });
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }).lane, 'operator-blocked');
  assert.equal(f.wake().triggered, true);
  assert.equal(f.intent().head_sha, headSha);
  assert.equal(f.intent().actor, 'fixture-operator');
  assert.match(f.db.prepare('SELECT rereview_reason FROM reviewed_prs').get().rereview_reason, /operator-waiver-observation/);
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }), null);
  assert.equal(f.wake(), null);
  // Even after restart/settlement restores the old projection, the same event
  // cannot create another receipt or reset a posted row.
  f.db.prepare("UPDATE explicit_review_intents SET state='consumed'").run();
  f.db.prepare("UPDATE reviewed_prs SET review_status='posted', reviewer_head_sha=?, posted_at=?").run(headSha, before);
  recordNoProgressLaneRun(f.rootDir, { repo, prNumber }, { headSha, fingerprint: 'old-gate', progressClass: 'operator-decision-required', logger });
  assert.equal(f.wake().triggered, false);
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }), null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM explicit_review_intents').get().n, 1);
});

for (const invalid of ['removed', 'missing-actor', 'missing-event', 'old-event', 'same-time', 'moved-head', 'terminal']) {
  test(`LABELREARM-01: ${invalid} evidence cannot arm review`, t => {
    const f = fixture(t);
    if (invalid === 'removed') f.remove();
    if (invalid === 'missing-actor') f.event({ actor: null });
    if (invalid === 'missing-event') f.event({ id: null });
    if (invalid === 'old-event') f.event({ created_at: '2026-01-01T09:00:00Z' });
    if (invalid === 'same-time') f.event({ created_at: before });
    if (invalid === 'terminal') f.db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
    assert.equal(f.wake(invalid === 'moved-head' ? { headSha: 'b'.repeat(40) } : {}), null);
    assert.equal(f.intent(), undefined);
  });
}

test('LABELREARM-01: mixed actionable finding retains normal remediation', t => {
  const f = fixture(t, body.replace('## Blocking issues', '## Blocking issues\n- **Repair parser** — reject malformed input.'));
  assert.equal(f.wake({ readOperatorLabelImpl: () => assert.fail('mixed findings must not read labels') }), null);
  assert.equal(f.intent(), undefined);
});

test('LABELREARM-01: same live predicate rearms an existing stopped follow-up without overriding its budget', t => {
  const f = fixture(t);
  const job = buildFollowUpJob({ repo, prNumber, branch: 'fixture/topic', reviewerModel: 'codex', revisionRef: headSha, reviewBody: body });
  job.status = 'stopped'; job.remediationPlan.currentRound = 1; job.remediationPlan.maxRounds = 3;
  job.remediationPlan.stop = { code: `operator-label-required:${label}` };
  const dir = join(f.rootDir, 'data/follow-up-jobs/stopped'); mkdirSync(dir, { recursive: true });
  writeFollowUpJob(join(dir, `${job.jobId}.json`), job);
  assert.equal(operatorLabelSatisfiesStop(job, f.read({ repo, prNumber, label })), true);
  assert.equal(f.wake().triggered, true);
  const queued = findLatestFollowUpJob(f.rootDir, { repo, prNumber }).job;
  assert.equal(queued.status, 'pending');
  assert.equal(queued.remediationPlan.maxRounds, 3);
  assert.equal(queued.remediationPlan.operatorLabelSatisfactions.at(-1).eventId, '7');
});

test('LABELREARM-01: newer review during evidence read fences the reset', t => {
  const f = fixture(t);
  assert.equal(f.wake({ readOperatorLabelImpl: identity => {
    const result = f.read(identity);
    f.db.prepare("UPDATE reviewed_prs SET posted_at=?").run(now);
    return result;
  } }).status, 'changed');
  assert.equal(f.intent(), undefined);
});

test('LABELREARM-01: label removal after scheduling is visible to the fresh reviewer', t => {
  const f = fixture(t); assert.equal(f.wake().triggered, true); f.remove();
  assert.equal(f.read({ repo, prNumber, label }), null);
  // Historical findings survive scheduling; label presence never rewrites them.
  assert.equal(f.db.prepare('SELECT body_md FROM reviewer_passes').get().body_md, body);
});

test('LABELREARM-01: removal during rearm retains stopped job and the fresh review must decide', t => {
  const f = fixture(t);
  const job = buildFollowUpJob({ repo, prNumber, branch: 'fixture/topic', reviewerModel: 'codex', revisionRef: headSha, reviewBody: body });
  job.status = 'stopped'; job.remediationPlan.currentRound = 1; job.remediationPlan.maxRounds = 3;
  job.remediationPlan.stop = { code: `operator-label-required:${label}` };
  const dir = join(f.rootDir, 'data/follow-up-jobs/stopped'); mkdirSync(dir, { recursive: true });
  writeFollowUpJob(join(dir, `${job.jobId}.json`), job);
  let reads = 0;
  assert.throws(() => f.wake({ readOperatorLabelImpl: scope => {
    if (++reads === 2) f.remove();
    return f.read(scope);
  } }), /Cannot requeue/);
  assert.equal(findLatestFollowUpJob(f.rootDir, { repo, prNumber }).job.status, 'stopped');
  assert.ok(f.intent());
  assert.equal(f.read({ repo, prNumber, label }), null);
});


test('LABELREARM-01: a new label application can request a new observation after a spent gesture', t => {
  const f = fixture(t); assert.equal(f.wake().triggered, true);
  f.db.prepare("UPDATE explicit_review_intents SET state='consumed'").run();
  f.db.prepare("UPDATE reviewed_prs SET review_status='posted', reviewer_head_sha=?, posted_at=?").run(headSha, before);
  f.event({ id: 8 });
  assert.equal(f.wake().triggered, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM explicit_review_intents').get().n, 2);
});
