import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewAgyOversizedInChunks, elideLongDiffLines } from '../src/reviewer-harness.mjs';
import { persistReviewElisions } from '../src/reviewer.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { clearNoProgressLane, maybeFireOperatorDecisionRequiredAlert } from '../src/watcher-no-progress-lane.mjs';
import { deliverAlert, ensureAlertSinkDirs, drainPendingAlerts } from '../src/alert-delivery.mjs';
import { parkExhaustedReview, readReviewFailureDecision } from '../src/review-retry-exhaustion.mjs';

test('REVIEWLINE-01: 418 KB line fits with deterministic evidence and body note', async () => {
  const line = '+' + 'x'.repeat(418809);
  const hash = createHash('sha256').update(line).digest('hex');
  const diff = `diff --git a/data.json b/data.json\n--- a/data.json\n+++ b/data.json\n@@ -1 +1,2 @@\n${line}\n+normal\n`;
  const result = await reviewAgyOversizedInChunks(diff, '', {
    env: {}, maxBytes: 234464,
    reviewWithGeminiImpl: async (chunk) => {
      assert.ok(Buffer.byteLength(chunk) < 234464);
      assert.ok(chunk.includes(`bytes=418810; sha256=${hash}`));
      assert.ok(chunk.includes('elided unreviewed content'));
      assert.ok(chunk.includes('+normal'));
      return { reviewText: '## Blocking issues\n- None.\n## Verdict\nAPPROVE' };
    },
  });
  assert.equal(result.elisions[0].byteLength, 418810);
  assert.equal(result.elisions[0].sha256, hash);
  assert.match(result.reviewText, /data.json:1/);
  assert.equal(extractReviewVerdict(result.reviewText), 'Request changes');
});

test('REVIEWLINE-01: durable decision and page deduplicate per head', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-'));
  try {
    const pages = [];
    const args = { rootDir, repo: 'example/repo', prNumber: 1, headSha: 'a'.repeat(40),
      reason: 'non-recoverable', deliverAlertFn: async (...event) => pages.push(event),
      logger: { warn() {} } };
    await parkExhaustedReview(args);
    await parkExhaustedReview(args);
    assert.equal(pages.length, 1);
    const decision = readReviewFailureDecision(rootDir, args.repo, 1, args.headSha);
    assert.equal(pages[0][1].payload.decisionId, decision.id);
    assert.equal(decision.kind, 'informational');
    assert.equal(decision.options, undefined);
    assert.equal(decision.status, undefined);
    await parkExhaustedReview({ ...args, headSha: 'b'.repeat(40) });
    assert.equal(pages.length, 2);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('REVIEWLINE-01: failed gate shows its owner without changing success semantics', () => {
  const gate = pickAdversarialGateStatus({ reviewRow: {
    review_status: 'failed', operator_decision_id: 'review-failure-test',
  } });
  assert.equal(gate.state, 'success');
  assert.equal(gate.description, 'review failed — operator decision raised (review-failure-test)');
});


test('elided source content cannot produce a clean chunked verdict', async () => {
  const result = await reviewAgyOversizedInChunks(
    `diff --git a/payload.js b/payload.js\n--- a/payload.js\n+++ b/payload.js\n@@ -0,0 +1 @@\n+${'x'.repeat(40000)}\n`, '', {
      env: {}, maxBytes: 234464,
      reviewWithGeminiImpl: async () => ({ reviewText: '## Blocking issues\n- None.\n## Verdict\nComment only' }),
    });
  assert.equal(extractReviewVerdict(result.reviewText), 'Request changes');
  assert.match(result.reviewText, /Unreviewed elided content at payload.js:1/);
  assert.match(result.reviewText, new RegExp(result.elisions[0].sha256));
});

test('elision evidence follows hunk sides and preserves UTF-8 boundaries', () => {
  const result = elideLongDiffLines([
    'diff --git a/old.js b/new.js', '--- a/old.js', '+++ b/new.js',
    '@@ -10,2 +20,2 @@', '+++ fake.js', '-' + 'é'.repeat(100), '+' + '🙂'.repeat(100),
    'diff --git a/deleted.js b/deleted.js', '--- a/deleted.js', '+++ /dev/null',
    '@@ -30 +0,0 @@', '-' + 'é'.repeat(100),
  ].join('\n'), { thresholdBytes: 50, edgeBytes: 8 });
  assert.deepEqual(result.elisions.map(({ path, line, side }) => ({ path, line, side })), [
    { path: 'old.js', line: 10, side: 'old' },
    { path: 'new.js', line: 21, side: 'new' },
    { path: 'deleted.js', line: 30, side: 'old' },
  ]);
  assert.ok(!result.diff.includes('\ufffd'));
});

test('raw hard ceiling refuses oversized content before reviewer dispatch', async () => {
  await assert.rejects(reviewAgyOversizedInChunks('+' + 'x'.repeat(2000), '', {
    env: { ADVERSARIAL_REVIEW_CHUNK_HARD_MAX_BYTES: '1500' }, maxBytes: 234464,
    reviewWithGeminiImpl: async () => assert.fail('must not dispatch above raw ceiling'),
  }), /hard ceiling exceeded/);
});

test('park, deliver, clear lane, park same head queues a fresh page and reason', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-repage-'));
  const env = { ALERT_TO: '123456', ADVERSARIAL_ALERT_DELIVERY_ROOT: rootDir };
  const requestText = async () => ({ statusCode: 200, body: '{}' });
  const fsImpl = { readFileSync: () => 'hook-token' };
  try {
    ensureAlertSinkDirs(rootDir);
    const queued = [];
    const args = { rootDir, repo: 'example/repo', prNumber: 1, headSha: 'a'.repeat(40),
      reason: 'first failure', logger: { warn() {} },
      deliverAlertFn: async (text, event) => queued.push(await deliverAlert(text, { ...event, env, requestText, fsImpl })),
    };
    assert.equal(await parkExhaustedReview(args), true);
    const firstDecision = readReviewFailureDecision(rootDir, args.repo, 1, args.headSha);
    await drainPendingAlerts({ env, requestText, fsImpl });
    assert.ok(readFileSync(join(rootDir, 'data', 'alert-delivery', 'delivered', `${queued[0].id}.json`)));
    assert.equal(await parkExhaustedReview(args), false);
    clearNoProgressLane(rootDir, args, { logger: args.logger });
    assert.equal(await parkExhaustedReview({ ...args, reason: 'second failure' }), true);
    const nextDecision = readReviewFailureDecision(rootDir, args.repo, 1, args.headSha);
    assert.equal(firstDecision.id, nextDecision.id);
    assert.notEqual(firstDecision.seriesId, nextDecision.seriesId);
    assert.equal(nextDecision.reason, 'second failure');
    assert.equal(queued.length, 2);
    assert.notEqual(queued[0].id, queued[1].id);
    assert.equal(queued[1].status, 'queued');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('decision storage failure still pages with a computed ID', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-storage-'));
  try {
    mkdirSync(join(rootDir, 'data'));
    writeFileSync(join(rootDir, 'data', 'review-failure-decisions'), 'not a directory');
    const pages = [];
    assert.equal(await parkExhaustedReview({ rootDir, repo: 'example/repo', prNumber: 1,
      headSha: 'a'.repeat(40), reason: 'failed', logger: { warn() {} },
      deliverAlertFn: async (...event) => pages.push(event),
    }), true);
    assert.match(pages[0][1].payload.decisionId, /^review-failure-/);
    assert.equal(pages[0][1].payload.decisionSeriesId, null);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('legacy exhaustion debounce survives deployment of the failure record', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-legacy-'));
  try {
    const args = { rootDir, identity: { repo: 'example/repo', prNumber: 1 },
      headSha: 'a'.repeat(40), fingerprint: 'review-retry-cap-exhausted',
      noProgressTicks: 1, thresholdTicks: 1, deliverAlertFn: async () => {}, logger: { warn() {} } };
    await maybeFireOperatorDecisionRequiredAlert(args);
    assert.equal(await parkExhaustedReview({ ...args, ...args.identity,
      reason: 'failed', deliverAlertFn: async () => assert.fail('legacy head already paged'),
    }), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('elision artifact faults cannot fail a completed review', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-evidence-'));
  const args = { rootDir, repo: 'example/repo', prNumber: 1, headSha: 'b'.repeat(40),
    elisions: [{ path: 'payload.js', line: 1 }], logger: { warn() {} } };
  try {
    assert.equal(persistReviewElisions(args), true);
    const metadataDir = join(rootDir, 'data', 'review-elisions');
    const metadata = JSON.parse(readFileSync(join(metadataDir, `example--repo-1-${args.headSha}.json`)));
    assert.equal(metadata.headSha, args.headSha);
    assert.equal(persistReviewElisions({ ...args, headSha: null }), false);
    rmSync(metadataDir, { recursive: true });
    writeFileSync(metadataDir, 'not a directory');
    assert.equal(persistReviewElisions(args), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
