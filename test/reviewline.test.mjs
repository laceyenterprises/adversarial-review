import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdversarialGateSnapshot, pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewAgyOversizedInChunks, elideLongDiffLines } from '../src/reviewer-harness.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { persistReviewElisions } from '../src/reviewer.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
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
  assert.equal(gate.description, 'Adversarial review failed before posting; operator decides. — operator decision review-failure-test');
});

test('failure decision descriptions preserve the terminal failure class', () => {
  for (const [failure_class, reason] of [
    ['reviewer-timeout', 'reviewer-timeout'],
    ['launchctl-bootstrap', 'reviewer-launchctl-bootstrap'],
    ['cascade', 'reviewer-cascade'],
  ]) {
    const gate = pickAdversarialGateStatus({ reviewRow: {
      review_status: 'failed', failure_class, operator_decision_id: 'review-failure-test',
    } });
    assert.equal(gate.reason, reason);
    assert.equal(gate.state, 'success');
    assert.match(gate.description, / — operator decision review-failure-test$/);
  }
});

test('gate snapshots show failure decisions only for the current failure observation', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewline-gate-'));
  try {
    const repo = 'example/repo';
    const prNumber = 1;
    const headSha = 'a'.repeat(40);
    await parkExhaustedReview({ rootDir, repo, prNumber, headSha, reason: 'first failure', logger: { warn() {} } });
    const decision = readReviewFailureDecision(rootDir, repo, prNumber, headSha);
    const updatedMs = Date.parse(decision.updatedAt);
    for (const [failed_at, expectedId] of [
      [new Date(updatedMs - 1000).toISOString(), decision.id],
      [decision.updatedAt, decision.id],
      [new Date(updatedMs + 1000).toISOString(), undefined],
      [null, undefined],
      ['invalid', undefined],
    ]) {
      const snapshot = await buildAdversarialGateSnapshot(rootDir, { repo, prNumber, headSha,
        reviewRow: { review_status: 'failed', failure_class: 'reviewer-timeout', failed_at,
          operator_decision_id: 'stale-injected-id' },
      });
      assert.equal(snapshot.reviewRow.operator_decision_id, expectedId);
      const gate = pickAdversarialGateStatus(snapshot);
      assert.equal(gate.reason, 'reviewer-timeout');
      assert.equal(gate.description.includes('operator decision review-failure-'), Boolean(expectedId));
    }
    const otherHead = await buildAdversarialGateSnapshot(rootDir, { repo, prNumber, headSha: 'b'.repeat(40),
      reviewRow: { review_status: 'failed', failed_at: decision.updatedAt },
    });
    assert.equal(otherHead.reviewRow.operator_decision_id, undefined);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('elided additions fail closed and remain distinct findings for every reviewer model', async () => {
  const diff = `diff --git a/payload.js b/payload.js\n--- a/payload.js\n+++ b/payload.js\n@@ -0,0 +1,2 @@\n+${'x'.repeat(300000)}\n+${'y'.repeat(300000)}\n`;
  for (const reviewerModel of ['gemini', 'claude', 'codex']) {
    for (const hasReviewerFinding of [false, true]) {
      const reviewText = hasReviewerFinding
        ? '## Summary\nReviewed.\n## Blocking issues\n- **Existing issue**\n  - **File:** payload.js\n  - **Problem:** Existing reviewer finding.\n## Verdict\nRequest changes'
        : '## Summary\nReviewed.\n## Blocking issues\n- None.\n## Verdict\nComment only';
      const run = async () => ({ reviewText, rawReviewText: reviewText,
        needsSanitize: reviewerModel === 'codex' });
      const result = await reviewAgyOversizedInChunks(diff, '', {
        env: {}, maxBytes: 234464, reviewerModel,
        reviewWithGeminiImpl: run, dispatchReviewerModelImpl: run,
      });
      assert.equal(extractReviewVerdict(result.reviewText), 'Request changes');
      const findings = parseBlockingFindingsSection(result.reviewText);
      const elisionFindings = findings.filter((finding) => finding.title.startsWith('Unreviewed elided content'));
      assert.equal(elisionFindings.length, 2);
      assert.equal(findings.length, hasReviewerFinding ? result.chunks.length + 2 : 2);
      for (const [index, finding] of elisionFindings.entries()) {
        assert.equal(finding.file, 'payload.js');
        assert.match(finding.lines, new RegExp(`^${index + 1} `));
        assert.match(finding.problem, new RegExp(result.elisions[index].sha256));
        assert.match(finding.recommendedFix, /reviewable diff/);
      }
    }
  }
});

test('long additions that fit are reviewed in full, even within an oversized file', async () => {
  for (const byteLength of [40 * 1024, 200 * 1024]) {
    for (const lines of [1, 8]) {
      const added = '+' + 'x'.repeat(byteLength);
      const diff = `diff --git a/payload.js b/payload.js\n--- a/payload.js\n+++ b/payload.js\n@@ -0,0 +1,${lines} @@\n${Array(lines).fill(added).join('\n')}\n`;
      for (const threshold of ['1024', '1000000']) {
        let reviewedLines = 0;
        const result = await reviewAgyOversizedInChunks(diff, '', {
          env: { ADVERSARIAL_REVIEW_LONG_LINE_MAX_BYTES: threshold }, maxBytes: 234464,
          reviewWithGeminiImpl: async (chunk, context) => {
            assert.doesNotMatch(chunk, /elided unreviewed content/);
            reviewedLines += chunk.split('\n').filter((line) => line === added).length;
            assert.ok(Buffer.byteLength(buildPromptForReviewerModel('gemini', chunk, context,
              { promptStage: 'first', runtime: 'antigravity' })) <= 234464);
            return { reviewText: '## Blocking issues\n- None.\n## Verdict\nComment only' };
          },
        });
        assert.equal(reviewedLines, lines);
        assert.deepEqual(result.elisions, []);
        assert.equal(extractReviewVerdict(result.reviewText), 'Comment only');
      }
    }
  }
});

test('long context and deletions do not create synthetic blockers', async () => {
  for (const kind of [' ', '-']) {
    for (const byteLength of [40 * 1024, 300000]) {
      const diff = [
        'diff --git a/small.js b/small.js', '--- a/small.js', '+++ b/small.js', '@@ -0,0 +1 @@', '+small',
        'diff --git a/data.json b/data.json', '--- a/data.json',
        kind === '-' ? '+++ /dev/null' : '+++ b/data.json',
        kind === '-' ? '@@ -10 +0,0 @@' : '@@ -10,2 +20,2 @@',
        kind + 'x'.repeat(byteLength),
        ...(kind === ' ' ? ['-old', '+new'] : []),
      ].join('\n');
      const result = await reviewAgyOversizedInChunks(diff, '', {
        env: {}, maxBytes: 234464,
        reviewWithGeminiImpl: async () => ({ reviewText: '## Blocking issues\n- None.\n## Verdict\nComment only' }),
      });
      assert.equal(extractReviewVerdict(result.reviewText), 'Comment only');
      if (byteLength === 300000) {
        assert.equal(result.elisions.length, 1);
        assert.equal(result.elisions[0].kind, kind);
        assert.equal(result.elisions[0].diffLine, 10);
        assert.equal(result.elisions[0].path, 'data.json');
        assert.equal(result.elisions[0].line, kind === '-' ? 10 : 20);
        assert.match(result.reviewText, /## Blocking issues\n- None\./);
        assert.match(result.reviewText, new RegExp(`## Non-blocking issues\\n- \\*\\*Elided ${kind === '-' ? 'deleted' : 'context'} content`));
        assert.match(result.reviewText, new RegExp(result.elisions[0].sha256));
        const [finding] = parseNonBlockingFindingsSection(result.reviewText);
        assert.equal(finding.file, 'data.json');
        assert.match(finding.problem, new RegExp(result.elisions[0].sha256));
      } else assert.deepEqual(result.elisions, []);
    }
  }
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
