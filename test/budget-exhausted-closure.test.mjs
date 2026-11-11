import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { routeBudgetExhaustedReviewToClosure } from '../src/hamclose-review-admission.mjs';
import { resolveClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { budgetExhaustedClosureEvidence } from '../src/adversarial-gate-status.mjs';
import { FOLLOW_UP_JOB_SCHEMA_VERSION } from '../src/follow-up-jobs.mjs';

const repo = 'example/project', prNumber = 42;
const headSha = 'a'.repeat(40), reviewedHead = 'b'.repeat(40);
const at = '2026-01-01T01:00:00.000Z';
const suppression = { suppressed: true, reason: 'post-budget-final-review-completed-for-pr' };

function fixture(t, status) {
  const root = mkdtempSync(join(tmpdir(), 'budget-closure-'));
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,revision_ref,reviewer_head_sha,rereview_requested_at,rereview_reason)
    VALUES (?,? ,?,'gemini','open',?,?,?,?,'auto-refresh')`)
    .run(repo, prNumber, at, status, headSha, headSha, at);
  db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,ended_at,status,head_sha,gh_comment_id)
    VALUES (?,?,1,'gemini','rereview',?,?,'completed',?,'synthetic-review')`)
    .run(repo, prNumber, at, at, reviewedHead);
  const row = () => db.prepare('SELECT * FROM reviewed_prs').get();
  const logs = [];
  const route = (decision = suppression, prior = row()) => routeBudgetExhaustedReviewToClosure({
    db, repo, prNumber, headSha, row: prior, suppression: decision, logger: { log: line => logs.push(line) },
  });
  return { root, db, row, route, logs };
}

test('read-only rescue projection reads shared final-push admission without changing the row', t => {
  const f = fixture(t, 'pending');
  const dir = join(f.root, 'data/follow-up-jobs/completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'example__project-pr-42-final.json'), JSON.stringify({
    repo, prNumber, status: 'completed', completedAt: at, revisionRef: reviewedHead,
    completion: { finalRemediationPush: true, workerPushedHeadSha: headSha },
    reReview: { requested: false, nextAction: { action: 'wait-for-CI', head: headSha } },
  }));
  const before = f.row();
  const readonly = new Database(join(f.root, 'data/reviews.db'), { readonly: true, fileMustExist: true });
  t.after(() => readonly.close());
  const input = { rootDir: f.root, db: readonly, repo, prNumber, headSha,
    reviewRow: before, logger: { warn() {} } };
  assert.deepEqual(budgetExhaustedClosureEvidence(input), {
    headSha, owner: 'hammer', reason: 'budget-exhausted-closure',
  });
  assert.deepEqual(f.row(), before);
  assert.equal(budgetExhaustedClosureEvidence({ ...input,
    reviewRow: { ...before, rereview_reason: 'FSR-06B: synthetic request' } }), null);
});

test('REMEDIATEEXEC-01: rescue projects a spent unpublished attempt to closure', t => {
  const f = fixture(t, 'posted');
  const dir = join(f.root, 'data/follow-up-jobs/stopped');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'example__project-pr-42-unpublished.json');
  const job = { schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION, jobId: 'example__project-pr-42-unpublished', repo, prNumber,
    status: 'stopped', stoppedAt: at, revisionRef: headSha,
    remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'committed-unpublished' } } };
  writeFileSync(path, JSON.stringify(job));
  const before = f.row();
  const input = { rootDir: f.root, db: f.db, repo, prNumber, headSha, reviewRow: before,
    logger: { log() {}, warn() {} } };
  assert.deepEqual(budgetExhaustedClosureEvidence(input), {
    headSha, owner: 'hammer', reason: 'budget-exhausted-closure',
  });
  assert.deepEqual(f.row(), before);
  writeFileSync(path, JSON.stringify({ ...job,
    remediationPlan: { ...job.remediationPlan, stop: { code: 'operator-stop' } } }));
  assert.equal(budgetExhaustedClosureEvidence(input), null, 'new budget proof cannot release an operator stop');
  writeFileSync(path, JSON.stringify(job));
  // Live ownership always precedes admission, even when terminal history is newer.
  const active = join(f.root, 'data/follow-up-jobs/in-progress');
  mkdirSync(active, { recursive: true });
  writeFileSync(join(active, 'example__project-pr-42-active.json'), JSON.stringify({
    ...job, jobId: 'active', status: 'in_progress', lastHeartbeatAt: new Date().toISOString(),
    remediationWorker: { state: 'running' },
  }));
  assert.equal(budgetExhaustedClosureEvidence(input), null);
});

test('importing rescue budget policy never opens a writable review-state handle', t => {
  const f = fixture(t, 'pending');
  const stateUrl = new URL('../src/review-state.mjs', import.meta.url).href;
  const gateUrl = new URL('../src/adversarial-gate-status.mjs', import.meta.url).href;
  const loader = join(f.root, 'loader.mjs'), register = join(f.root, 'register.mjs');
  writeFileSync(loader, `export async function load(url, context, nextLoad) {
    if (url === ${JSON.stringify(stateUrl)}) return { format: 'module', shortCircuit: true,
      source: ${JSON.stringify(`export * from ${JSON.stringify(stateUrl + '?actual')};
        globalThis.budgetImportStateIntercepted = true;
        export function openReviewStateDb() { throw Error('unexpected writable review database'); }`)} };
    return nextLoad(url, context);
  }`);
  writeFileSync(register, `import { register } from 'node:module';
    register(${JSON.stringify(pathToFileURL(loader).href)});`);
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
    '--import', register, '--input-type=module',
    '-e', `await import(${JSON.stringify(gateUrl)});
      if (!globalThis.budgetImportStateIntercepted) throw Error('writer interception did not load');`],
  { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

for (const status of ['pending', 'pending-upstream', 'ci-blocked']) {
  test(`spent budget restores only the delivered verdict from ${status}, once`, t => {
    const f = fixture(t, status);
    assert.equal(f.route(), true);
    assert.equal(f.row().review_status, 'posted');
    assert.equal(f.row().reviewer_head_sha, reviewedHead, 'queued/failed head cannot become a delivered verdict');
    assert.equal(f.row().rereview_requested_at, null);
    assert.equal(f.route(), false);
    assert.ok(f.logs.length <= 1);
  });
}

test('within-budget admission and concurrent requests retain their row', t => {
  const f = fixture(t, 'pending'), before = f.row();
  assert.equal(f.route({ suppressed: false, reason: 'owed-post-budget-final-review' }), false);
  assert.equal(f.route({ suppressed: true, reason: 'same-head-review-in-flight' }), false);
  assert.deepEqual(f.row(), before);
  f.db.prepare("UPDATE reviewed_prs SET rereview_reason='operator-request'").run();
  assert.equal(f.route(suppression, before), false, 'CAS preserves a concurrent request');
  assert.equal(f.row().rereview_reason, 'operator-request');
});

for (const [name, checks, mergeable, extra, reason, intent] of [
  ['green stale builder head', 'SUCCESS', 'MERGEABLE', {}, 'review-ceiling', 'dispatch'],
  ['conflicting head', 'SUCCESS', 'CONFLICTING', {}, 'conflict-rebase', 'dispatch'],
  ['red CI', 'FAILURE', 'MERGEABLE', {}, 'ci-red-final', 'dispatch'],
  ['live closer', 'SUCCESS', 'MERGEABLE', {
    lease: { status: 'dispatched', headSha, lrqId: 'synthetic-closer', updatedAt: at },
  }, 'live-owner', 'owned'],
]) test(`restored budget head selects ${name} through the shared evaluator`, async t => {
  const f = fixture(t, 'pending-upstream');
  assert.equal(f.route(), true);
  const shared = await resolveClosureNextAction({
    subjectKey: `${repo}#${prNumber}`, observedAt: at,
    candidate: { headSha, prState: 'OPEN', mergeable, labels: [] },
    autonomousMergeExecutionEnabled: true,
    ...(name === 'live closer' ? { readLaunches: async () => ({ state: 'complete',
      value: { closer: { headSha, status: 'running', launchRequestId: 'synthetic-closer' } } }) } : {}),
    input: { currentHead: headSha, reviewAdmissionRow: f.row(), roundsLeft: false,
      checks, mergeable, strictMode: true, lease: null, ...extra,
      reviewState: { headSha: reviewedHead, verdict: 'approved', reviewCycleExhausted: true,
        blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } },
  });
  assert.equal(shared.decision.action, 'hammer');
  assert.equal(shared.decision.reason, reason);
  assert.equal(shared.decision.queue.intent, intent);
  assert.notEqual(classifyClosureOwnership(shared.decision, headSha).decision, 'rereview-eligible');
});
