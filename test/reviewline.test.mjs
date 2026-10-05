import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
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
      assert.ok(chunk.includes('reviewer must flag if this content needs line-level review'));
      assert.ok(chunk.includes('+normal'));
      return { reviewText: '## Blocking issues\n- None.\n## Verdict\nAPPROVE' };
    },
  });
  assert.equal(result.elisions[0].byteLength, 418810);
  assert.equal(result.elisions[0].sha256, hash);
  assert.match(result.reviewText, /data.json:1/);
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
    assert.deepEqual(decision.options, ['retrigger after a fix', 'accept partial review', 'block']);
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
