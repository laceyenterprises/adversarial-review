import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { observeOperatorLabelReviewWake } from '../src/operator-label-review-wake.mjs';
import { readFollowUpOperatorLabel, operatorLabelSatisfiesStop } from '../src/follow-up-operator-label.mjs';
import { pendingExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { buildFollowUpJob, writeFollowUpJob, claimNextFollowUpJob } from '../src/follow-up-jobs.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';
import { recordNoProgressLaneRun, readNoProgressLane, operatorDecisionAlertStateDir } from '../src/watcher-no-progress-lane.mjs';
import { createLabelControlObservationCache, observeOperatorLabelWakes } from '../src/operator-label-wake.mjs';
import { createGitHubPRLabelControlsAdapter } from '../src/adapters/operator/github-pr-label-controls/index.mjs';
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
  const observe = async (_subject, _head, label) => {
    const evidence = read({ repo, prNumber, label });
    return evidence && { applied: true, observedRevisionRef: evidence.headSha,
      actor: evidence.actor, eventId: evidence.eventId, observedAt: evidence.appliedAt };
  };
  const args = { rootDir, db, repo, prNumber, headSha, logger, now: () => now,
    labelNames: [label], subjectRef: { subjectExternalId: `${repo}#${prNumber}` }, observeLabelControlImpl: observe };
  return { rootDir, db, args, read, remove() { present = false; }, event(value) { event = { ...event, ...value }; },
    wake(overrides = {}) { return observeOperatorLabelReviewWake({ ...args, ...overrides }); },
    intent() { return pendingExplicitReviewIntent(db, { repo, prNumber, headSha, now }); } };
}

test('LABELREARM-01: gated posted review with no job arms one exact-head waiver observation and exits lane', async t => {
  const f = fixture(t);
  recordNoProgressLaneRun(f.rootDir, { repo, prNumber }, { headSha, fingerprint: 'operator-blocked', progressClass: 'operator-decision-required', logger });
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }).lane, 'operator-blocked');
  assert.equal((await f.wake()).triggered, true);
  assert.equal(f.intent().head_sha, headSha);
  assert.equal(f.intent().actor, 'fixture-operator');
  assert.match(f.db.prepare('SELECT rereview_reason FROM reviewed_prs').get().rereview_reason, /operator-waiver-observation/);
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }), null);
  assert.equal(await f.wake(), null);
  // Even after restart/settlement restores the old projection, the same event
  // cannot create another receipt or reset a posted row.
  f.db.prepare("UPDATE explicit_review_intents SET state='consumed'").run();
  f.db.prepare("UPDATE reviewed_prs SET review_status='posted', reviewer_head_sha=?, posted_at=?").run(headSha, before);
  recordNoProgressLaneRun(f.rootDir, { repo, prNumber }, { headSha, fingerprint: 'old-gate', progressClass: 'operator-decision-required', logger });
  assert.equal((await f.wake()).triggered, false);
  assert.equal(readNoProgressLane(f.rootDir, { repo, prNumber }).lane, 'operator-blocked');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM explicit_review_intents').get().n, 1);
});

for (const invalid of ['removed', 'missing-actor', 'missing-event', 'old-event', 'same-time', 'moved-head', 'terminal']) {
  test(`LABELREARM-01: ${invalid} evidence cannot arm review`, async t => {
    const f = fixture(t);
    if (invalid === 'removed') f.remove();
    if (invalid === 'missing-actor') f.event({ actor: null });
    if (invalid === 'missing-event') f.event({ id: null });
    if (invalid === 'old-event') f.event({ created_at: '2026-01-01T09:00:00Z' });
    if (invalid === 'same-time') f.event({ created_at: before });
    if (invalid === 'terminal') f.db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
    assert.equal(await f.wake(invalid === 'moved-head' ? { headSha: 'b'.repeat(40) } : {}), null);
    assert.equal(f.intent(), undefined);
  });
}

test('LABELREARM-01: mixed actionable finding retains normal remediation', async t => {
  const f = fixture(t, body.replace('## Blocking issues', '## Blocking issues\n- **Repair parser** — reject malformed input.'));
  assert.equal(await f.wake({ observeLabelControlImpl: () => assert.fail('mixed findings must not read labels') }), null);
  assert.equal(f.intent(), undefined);
});

for (const round of [1, 3]) {
  test(`LABELREARM-01: waiver observation preserves stopped job and round ${round} through next claim`, async t => {
    const f = fixture(t);
    const job = buildFollowUpJob({ repo, prNumber, branch: 'fixture/topic', reviewerModel: 'codex', revisionRef: headSha, reviewBody: body });
    job.status = 'stopped'; job.remediationPlan.currentRound = round; job.remediationPlan.maxRounds = 3;
    job.remediationPlan.stop = { code: `operator-label-required:${label}` };
    const dir = join(f.rootDir, 'data/follow-up-jobs/stopped'); mkdirSync(dir, { recursive: true });
    writeFollowUpJob(join(dir, `${job.jobId}.json`), job);
    const saved = findLatestFollowUpJob(f.rootDir, { repo, prNumber }).job;
    assert.equal(operatorLabelSatisfiesStop(job, f.read({ repo, prNumber, label })), true);
    assert.equal((await f.wake()).triggered, true);
    assert.equal(claimNextFollowUpJob({ rootDir: f.rootDir }), null);
    assert.deepEqual(findLatestFollowUpJob(f.rootDir, { repo, prNumber }).job, saved);
  });
}

test('LABELREARM-01: newer review during evidence read fences the reset', async t => {
  const f = fixture(t);
  assert.equal((await f.wake({ observeLabelControlImpl: async (...args) => {
    const result = await f.args.observeLabelControlImpl(...args);
    f.db.prepare("UPDATE reviewed_prs SET posted_at=?").run(now);
    return result;
  } })).status, 'changed');
  assert.equal(f.intent(), undefined);
});

test('LABELREARM-01: label removal after scheduling is visible to the fresh reviewer', async t => {
  const f = fixture(t); assert.equal((await f.wake()).triggered, true); f.remove();
  assert.equal(f.read({ repo, prNumber, label }), null);
  // Historical findings survive scheduling; label presence never rewrites them.
  assert.equal(f.db.prepare('SELECT body_md FROM reviewer_passes').get().body_md, body);
});

test('LABELREARM-01: a new label application can request a new observation after a spent gesture', async t => {
  const f = fixture(t); assert.equal((await f.wake()).triggered, true);
  f.db.prepare("UPDATE explicit_review_intents SET state='consumed'").run();
  f.db.prepare("UPDATE reviewed_prs SET review_status='posted', reviewer_head_sha=?, posted_at=?").run(headSha, before);
  f.event({ id: 8 });
  assert.equal((await f.wake()).triggered, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM explicit_review_intents').get().n, 2);
});

test('LABELREARM-01: cached absence of any required label skips every live read', async t => {
  const f = fixture(t);
  const unread = () => assert.fail('cached absence must not read labels');
  assert.equal(await f.wake({ labelNames: [], observeLabelControlImpl: unread }), null);
  assert.equal(await f.wake({ labelNames: ['unrelated'], observeLabelControlImpl: unread }), null);
  assert.equal(f.intent(), undefined);
  const multiple = fixture(t, body.replace('## Blocking issues',
    '## Blocking issues\n- **[ci-cost-guard]** operator-label-required:ci-cost-approved'));
  assert.equal(await multiple.wake({ observeLabelControlImpl: unread }), null);
});

test('LABELREARM-01: waiver and generic wake share one async label observation per cycle', async t => {
  const f = fixture(t);
  let reads = 0;
  const operatorSurface = createGitHubPRLabelControlsAdapter({
    fetchLatestLabelEventImpl: async () => {
      reads++;
      // Ensure the caller yields while waiting for operator evidence.
      await new Promise(resolve => setImmediate(resolve));
      return { id: '7', actor: 'fixture-operator', headSha, createdAt: appliedAt };
    },
  });
  const observeLabelControlImpl = createLabelControlObservationCache(operatorSurface);
  assert.equal((await f.wake({ observeLabelControlImpl })).triggered, true);
  await observeOperatorLabelWakes({ ...f.args, operatorSurface, observeLabelControlImpl,
    now: () => Date.parse(appliedAt), env: {} });
  assert.equal(reads, 1);
});

for (const status of ['blocked', 'already-pending', 'changed']) {
  test(`LABELREARM-01: ${status} request retains lane and alert state on repeated ticks`, async t => {
    const f = fixture(t);
    recordNoProgressLaneRun(f.rootDir, { repo, prNumber }, {
      headSha, fingerprint: 'operator-blocked', progressClass: 'operator-decision-required', logger,
    });
    const lane = readNoProgressLane(f.rootDir, { repo, prNumber });
    const alertDir = operatorDecisionAlertStateDir(f.rootDir);
    mkdirSync(alertDir, { recursive: true });
    const alertPath = join(alertDir, `example__review-fixture-pr-${prNumber}-fixture.json`);
    const alert = JSON.stringify({ alertedAt: before, headSha });
    writeFileSync(alertPath, alert);
    for (let tick = 0; tick < 2; tick++) {
      assert.equal((await f.wake({ requestReviewImpl: () => ({ triggered: false, status }) })).status, status);
      assert.deepEqual(readNoProgressLane(f.rootDir, { repo, prNumber }), lane);
      assert.equal(readFileSync(alertPath, 'utf8'), alert);
    }
  });
}
