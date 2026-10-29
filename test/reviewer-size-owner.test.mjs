import './helpers/registry-session-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { reviewerSizeFacts, reviewerSizeFactsLine, dispatchReviewerSizeUpdate } from '../src/reviewer-size-owner.mjs';
import { alertClioOversizedAgyFailure } from '../src/reviewer-alerts.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { prepareMarkSizeFailed, prepareMarkAttemptStarted } from '../src/review-state-statements.mjs';

const repo = 'example-org/example-repo';
const headSha = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const session = 'synthetic-size-review';
const diff = 'diff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -0,0 +1 @@\n+é\n'
  + 'diff --git a/data/generated.json b/data/generated.json\n--- a/data/generated.json\n+++ b/data/generated.json\n@@ -0,0 +1 @@\n+' + 'x'.repeat(12000) + '\n';
const facts = reviewerSizeFacts({ diff, headSha, promptBytes: 14000, maxBytes: 10000, maxChunks: 2,
  chunkPlan: { chunkCount: 3, capMs: 20000, requiredMs: 30000 } });

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'size-owner-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status,
    reviewer_head_sha, reviewer_session_uuid, review_attempts, pr_state)
    VALUES (?, 42, '2026-01-01T00:00:00Z', 'gemini', 'reviewing', ?, ?, 0, 'open')`).run(repo, headSha, session);
  const dispatches = [];
  const alerts = [];
  const options = { rootDir, repoPath: repo, prNumber: 42, reviewerHeadSha: headSha,
    reviewerSessionUuid: session, builderTag: 'codex', leaseRecoveryEnabled: true,
    result: { ok: false, failureClass: 'reviewer-prompt-too-large', error: 'synthetic size ceiling',
      stderr: reviewerSizeFactsLine(facts) },
    statements: { markSizeFailed: prepareMarkSizeFailed(db),
      markFailed: { run() { assert.fail('must use the head/session fence'); } },
      releaseReviewLease: { run() { assert.fail('size failure must remain terminal'); } },
    },
    dispatchSizeUpdateImpl: async (request) => { dispatches.push(request);
      return { dispatched: true, launchRequestId: 'lrq_synthetic_shrink_diff' }; },
    alertSizeFailureImpl: (request) => alertClioOversizedAgyFailure(request, {
      deliverAlertImpl: async (message, options) => { alerts.push({ message, options }); return { id: 'synthetic-alert' }; },
    }),
    log: { warn() {} },
  };
  return { rootDir, db, options, dispatches, alerts,
    row: () => db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = 42').get(repo) };
}

for (const failureClass of ['reviewer-prompt-too-large', 'reviewer-chunk-budget-exceeded']) {
  test(`terminal ${failureClass} records one shrink-diff owner, dispatch and enriched alert`, async (t) => {
    const f = fixture(t);
    f.options.result.failureClass = failureClass;
    const settlement = await settleReviewerAttempt(f.options);
    assert.equal(f.row().review_status, 'failed');
    assert.equal(f.row().review_attempts, 1);
    assert.equal(settlement.nextAction.action, 'shrink-diff');
    assert.equal(settlement.nextAction.head, headSha);
    assert.deepEqual(settlement.nextAction.facts, facts);
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.dispatches[0].workerClass, 'codex');
    assert.equal(f.dispatches[0].prNumber, 42);
    const brief = readFileSync(f.dispatches[0].promptPath, 'utf8');
    assert.match(brief, /without changing behaviour/);
    assert.match(brief, /compressing.*split/);
    assert.match(brief, /Push normally.*do not force-push/);
    for (const value of [facts.diffBytes, facts.maxBytes, facts.maxChunks, 'data/generated.json']) {
      assert.ok(brief.includes(String(value)));
    }
    const records = readdirSync(join(f.rootDir, 'data', 'review-size-actions')).filter(name => name.endsWith('.json'));
    assert.equal(records.length, 1);
    const record = JSON.parse(readFileSync(join(f.rootDir, 'data', 'review-size-actions', records[0]), 'utf8'));
    assert.deepEqual(record.nextAction, settlement.nextAction);
    assert.equal(record.dispatch.launchRequestId, 'lrq_synthetic_shrink_diff');
    assert.equal(f.alerts.length, 1);
    assert.equal(f.alerts[0].options.event, 'reviewer.oversized_agy_prompt');
    assert.deepEqual(f.alerts[0].options.payload.nextAction, settlement.nextAction);
    assert.equal(f.alerts[0].options.payload.dispatch.launchRequestId, 'lrq_synthetic_shrink_diff');
    assert.match(f.alerts[0].message, /shrink-diff.*owner: codex/);
    await settleReviewerAttempt(f.options);
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.row().review_attempts, 1);
    assert.equal(f.alerts.length, 1);
    // A repeat reviewer claim / restarted caller cannot dispatch twice either.
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing'").run();
    await settleReviewerAttempt(f.options);
    assert.equal(f.dispatches.length, 1);
  });
}

test('size evidence measures UTF-8 bytes and ranks the largest changed files', () => {
  assert.equal(facts.diffBytes, Buffer.byteLength(diff));
  assert.equal(facts.largestFiles[0].path, 'data/generated.json');
  assert.equal(facts.largestFiles.reduce((sum, file) => sum + file.diffBytes, 0), facts.diffBytes);
  const quoted = reviewerSizeFacts({ diff: 'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"\n+é\n' });
  assert.equal(quoted.largestFiles[0].path, 'café.md');
});

test('a new head claims an ordinary review; late old-head settlement cannot fail it or dispatch again', async (t) => {
  const f = fixture(t);
  await settleReviewerAttempt(f.options);
  const requested = requestReviewRereview({ rootDir: f.rootDir, db: f.db, repo, prNumber: 42,
    reviewer: 'gemini', headSha: nextHead, revisionRef: nextHead, requestedBy: 'synthetic-head-change' });
  assert.ok(requested);
  assert.equal(f.row().review_status, 'pending');
  const started = prepareMarkAttemptStarted(f.db).run('2026-01-02T00:00:00Z', 'synthetic-next-review',
    nextHead, nextHead, 1000, '2026-01-02T00:01:00Z', nextHead, repo, 42);
  assert.equal(started.changes, 1);
  assert.equal(f.row().review_status, 'reviewing');
  assert.equal(f.row().reviewer_head_sha, nextHead);
  const stale = await settleReviewerAttempt(f.options);
  assert.equal(stale.reason, 'size-failure-claim-mismatch');
  assert.equal(f.row().review_status, 'reviewing');
  assert.equal(f.dispatches.length, 1);
});

test('an unconfirmed dispatch retains the head reservation and alerts with the error', async (t) => {
  const f = fixture(t);
  let submissions = 0;
  f.options.dispatchSizeUpdateImpl = async () => { submissions++; throw new Error('synthetic lost acknowledgement'); };
  const settled = await settleReviewerAttempt(f.options);
  assert.match(settled.dispatch.error, /lost acknowledgement/);
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing'").run();
  await settleReviewerAttempt(f.options);
  assert.equal(submissions, 1);
  assert.match(f.alerts[0].message, /lost acknowledgement/);
});

test('an unwritable action store preserves the alert and refuses unreserved dispatch', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.rootDir, 'data', 'review-size-actions'), 'synthetic blocked store');
  const settled = await settleReviewerAttempt(f.options);
  assert.equal(f.row().review_status, 'failed');
  assert.equal(f.dispatches.length, 0);
  assert.match(settled.dispatch.error, /reservation failed/);
  assert.match(f.alerts[0].message, /reservation failed/);
});

test('PR update uses the shared branch-push dispatch path with the title builder class', async () => {
  for (const workerClass of ['codex', 'claude-code', 'clio-agent']) {
    const result = await dispatchReviewerSizeUpdate({ repo, prNumber: 42, workerClass,
      promptPath: '/synthetic/brief.md', dispatchKey: 'synthetic-size-key', env: { HQ_ROOT: '/synthetic/hq' },
      execFileImpl: async (command, args) => {
        assert.equal(command, 'hq');
        for (const [flag, value] of [['--pr', '42'], ['--worker-class', workerClass],
          ['--completion-shape', 'branch-push'], ['--required-outcome', 'push'],
          ['--idempotency-key', 'synthetic-size-key'], ['--repo', 'example-repo']]) {
          assert.equal(args[args.indexOf(flag) + 1], value);
        }
        return { stdout: JSON.stringify({ launchRequestId: 'lrq_synthetic_update' }) };
      },
    });
    assert.equal(result.launchRequestId, 'lrq_synthetic_update');
  }
});
