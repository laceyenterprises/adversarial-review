import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../src/kernel/verdict.mjs';
import { validateReviewerReply } from '../src/kernel/review-reply.mjs';
import { exactHeadReviewEventForBody } from '../src/reviewer-exact-head-post.mjs';
import { reconcileReviewVerdict, RECONCILE_VERDICT_INSTRUCTION } from '../src/reviewer-verdict-recovery.mjs';
import { createReviewSizeRecovery } from '../src/reviewer-large-diff.mjs';
import { __test__ as harness, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { classifyBlockingFindings } from '../src/merge-agent-review-classification.mjs';
import { buildReviewerPromptPrefix } from '../src/reviewer-prompt.mjs';
import { validateReviewArtifact } from '../src/adapters/reviewer-runtime/agent-os-hq/index.mjs';

const clean = '## Summary\nSynthetic review.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Suggested fixes\n- None.\n\n## Verdict\nNo blocking issues remain.\n\nComment only';
const contradictory = clean.replace('No blocking issues remain.', 'Two blocking issues remain: lost writes and an unusable recovery command.');
const card = '- **Lost write**\n  - **File:** `src/example.mjs`\n  - **Lines:** `3`\n  - **Problem:** Input or state: a worker exits; Wrong outcome: its acknowledged write is lost.\n  - **Why it matters:** State is lost.\n  - **Recommended fix:** Persist before acknowledging.';
const blocking = clean.replace('## Blocking issues\n- None.', `## Blocking issues\n${card}`)
  .replace('No blocking issues remain.', 'One blocking issue remains.').replace('Comment only', 'Request changes');
const dispatch = body => ({ rawReviewText: body, reviewText: body, tokenUsage: { input: 5, output: 2, total: 7 } });
const log = { warn() {} };
const { mergeChunkedAgyReviews } = harness;

test('verdict contradictions block parsing, count-based closure and exact-head approval', () => {
  for (const prose of ['Two blocking issues remain: lost writes and a broken command.',
    'One blocking issue: writes are lost.', '3 blocking issues remain.', 'Blocking issues remain.',
    'A blocking issue remains.', '**Two blocking issues remain.**']) {
    const body = clean.replace('No blocking issues remain.', prose);
    const parsed = parseReviewFindings(body);
    assert.equal(parsed.verdict_inconsistent, true, prose);
    assert.equal(parsed.blocking.state, 'unknown', prose);
    assert.equal(parsed.findingsCount, null, prose);
    assert.equal(normalizeEffectiveReviewVerdict(body), 'request-changes', prose);
    assert.equal(classifyBlockingFindings(body).state, 'unknown', prose);
    assert.equal(exactHeadReviewEventForBody(body), 'REQUEST_CHANGES', prose);
  }
});

test('zero/negative assertions stay permissive and consistent blocking reviews stay blocking', () => {
  for (const prose of ['No blocking issues remain.', 'Zero blocking issues.', '0 blocking issues remain.', 'No blocking issue remains.',
    'Two non-blocking issues remain.', 'Non blocking issues remain.']) {
    const body = clean.replace('No blocking issues remain.', prose);
    assert.equal(normalizeEffectiveReviewVerdict(body), 'comment-only', prose);
    assert.equal(parseReviewFindings(body).verdict_inconsistent, undefined, prose);
  }
  assert.equal(normalizeEffectiveReviewVerdict(blocking), 'request-changes');
  assert.equal(parseReviewFindings(blocking).blocking.state, 'known');
  assert.equal(parseReviewFindings(blocking).verdict_inconsistent, undefined);
});

test('reverse contradictions and empty-list request changes stay blocking', () => {
  for (const body of [blocking.replace('One blocking issue remains.', 'No blocking issues remain.'),
    blocking.replace('Request changes', 'Comment only'),
    blocking.replace('Request changes', 'Approve'),
    clean.replace('Comment only', 'Request changes')]) {
    assert.equal(normalizeEffectiveReviewVerdict(body), 'request-changes');
    assert.equal(parseReviewFindings(body).verdict_inconsistent, true);
  }
});

test('consistency uses the same formatted and explanatory verdict keywords as normalization', () => {
  for (const keyword of ['Comment only because the list is empty.', '**Comment only**', '- Comment only',
    'Approved with a note.']) {
    const body = blocking.replace('Request changes', keyword);
    assert.equal(parseReviewFindings(body).verdict_inconsistent, true, keyword);
    assert.equal(normalizeEffectiveReviewVerdict(body), 'request-changes', keyword);
  }
  for (const keyword of ['Request changes because writes are lost.', '**Request changes**', 'request_changes']) {
    const body = clean.replace('Comment only', keyword);
    assert.equal(parseReviewFindings(body).verdict_inconsistent, true, keyword);
  }
  assert.equal(normalizeEffectiveReviewVerdict(clean.replace('No blocking issues remain.',
    'Request changes from the prior round are now resolved.')), 'comment-only');
});

test('only unfenced Verdict prose supplies inconsistency evidence', () => {
  for (const body of [
    clean.replace('Synthetic review.', 'Two blocking issues remain.'),
    `${clean}\n\n## Simplicity and cost (advisory)\nTwo blocking issues remain.`,
    clean.replace('No blocking issues remain.', '```text\nTwo blocking issues remain.\n```'),
    clean.replace('No blocking issues remain.', '~~~text\nTwo blocking issues remain.\n~~~'),
  ]) assert.equal(normalizeEffectiveReviewVerdict(body), 'comment-only');
});

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'verdict-recovery-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo: 'example/project', prNumber: 7, headSha: 'a'.repeat(40), log };
}

test('one reconciliation uses the same diff/head context and can return a consistent review', async t => {
  const options = fixture(t);
  const calls = [];
  const recovery = createReviewSizeRecovery({
    diff: '+synthetic diff', extraContext: 'immutable head context', ...options,
    initialSizing: {}, resolveCwd: () => options.rootDir,
    resolveRoute: () => ({ oversized: false }),
    options: () => ({ reviewerModel: 'synthetic' }),
    run: async (model, diff, context) => {
      calls.push({ model, diff, context });
      return dispatch(calls.length === 1 ? contradictory : blocking);
    },
    chunk: () => assert.fail('small prompt requires no chunks'),
  });
  const result = await reconcileReviewVerdict({ ...options, dispatch: await recovery.run(), run: recovery.run });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].diff, calls[1].diff);
  assert.equal(calls[0].model, calls[1].model);
  assert.ok(calls[1].context.includes(RECONCILE_VERDICT_INSTRUCTION));
  assert.equal(result.reviewText, blocking);
  assert.equal(result.tokenUsage.total, 14);
  const dir = join(options.rootDir, 'data', 'reviewer-verdict-recovery');
  const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(record.verdict_inconsistent, true);
  assert.equal(record.status, 'reconciled');
  assert.equal(record.headSha, options.headSha);
  assert.equal(record.reviewBody, contradictory);
});

test('persistent inconsistency retries exactly once across restarts and simultaneous claims', async t => {
  const options = fixture(t);
  let calls = 0;
  const run = async () => { calls++; return dispatch(contradictory); };
  const results = await Promise.all([1, 2].map(() =>
    reconcileReviewVerdict({ ...options, dispatch: dispatch(contradictory), run })));
  results.push(await reconcileReviewVerdict({ ...options, dispatch: dispatch(contradictory), run }));
  results.push(await reconcileReviewVerdict({ ...options, headSha: options.headSha.toUpperCase(),
    dispatch: dispatch(contradictory), run }));
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
    assert.match(result.reviewText, /verdict_inconsistent: true/);
    assert.match(result.reviewText, /operator attention is required/i);
    assert.equal(validateReviewerReply(result.reviewText).ok, true);
  }
  await reconcileReviewVerdict({ ...options, headSha: 'b'.repeat(40), dispatch: dispatch(contradictory), run });
  assert.equal(calls, 2, 'a new immutable head has its own budget');
});

for (const firstPrNumber of [7, '7']) {
  test(`numeric and string PR numbers share one reservation (${typeof firstPrNumber} first)`, async t => {
    const options = fixture(t);
    let calls = 0;
    const run = async () => { calls++; return dispatch(contradictory); };
    const otherPrNumber = typeof firstPrNumber === 'number' ? '7' : 7;
    await Promise.all([firstPrNumber, otherPrNumber].map(prNumber =>
      reconcileReviewVerdict({ ...options, prNumber, dispatch: dispatch(contradictory), run })));
    await reconcileReviewVerdict({ ...options, prNumber: otherPrNumber,
      dispatch: dispatch(contradictory), run });
    assert.equal(calls, 1, 'caller types and restarts cannot replenish the head budget');
    const dir = join(options.rootDir, 'data', 'reviewer-verdict-recovery');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(record.prNumber, 7);
  });
}

test('a consistent clean reconciliation can clear the review without replenishing the head budget', async t => {
  const options = fixture(t);
  const result = await reconcileReviewVerdict({ ...options, dispatch: dispatch(contradictory),
    run: async () => ({ ...dispatch(clean), tokenUsage: null }) });
  assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'comment-only');
  assert.equal(result.tokenUsage.partial, true);
  await reconcileReviewVerdict({ ...options, dispatch: dispatch(contradictory),
    run: () => assert.fail('successful reconciliation still consumes the head budget') });
});

test('retry failure, malformed retry and unreadable reservation preserve the original blocker', async t => {
  const options = fixture(t);
  for (const [index, run] of [
    async () => { throw new Error('synthetic transport failure'); },
    async () => dispatch('invalid review'),
  ].entries()) {
    const result = await reconcileReviewVerdict({ ...options, prNumber: index, dispatch: dispatch(contradictory), run });
    assert.match(result.reviewText, /lost writes/);
    assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
    await reconcileReviewVerdict({ ...options, prNumber: index, dispatch: dispatch(contradictory),
      run: () => assert.fail('failed retries consume the reservation') });
  }
  const result = await reconcileReviewVerdict({ ...options, dispatch: dispatch(contradictory),
    writeFileAtomicImpl: () => { throw new Error('unreadable state'); },
    run: () => assert.fail('no retry without a durable reservation') });
  assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
});

test('reconciliation cannot sanitize away duplicate sections in the original raw review', async t => {
  const original = dispatch(contradictory);
  original.rawReviewText += '\n\n## Verdict\nApprove';
  await assert.rejects(reconcileReviewVerdict({ ...fixture(t), dispatch: original,
    run: () => assert.fail('invalid raw output must not reach reconciliation') }), /repeated required sections/);
});

test('incomplete canonical bodies and chunk markers receive an operator notice after exhaustion', async t => {
  for (const body of [contradictory.replace('## Summary\nSynthetic review.\n\n', ''),
    contradictory.replace('## Summary', '## Summary: compact summary'),
    mergeChunkedAgyReviews([{ reviewText: contradictory }])]) {
    const result = await reconcileReviewVerdict({ ...fixture(t), dispatch: dispatch(body),
      run: async () => dispatch(body) });
    assert.match(result.reviewText, /operator attention is required/i);
    assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
  }
});

test('an exhausted empty-list request-changes review is posted as blocking for operator attention', async t => {
  const body = clean.replace('Comment only', 'Request changes');
  const result = await reconcileReviewVerdict({ ...fixture(t), dispatch: dispatch(body), run: async () => dispatch(body) });
  assert.equal(validateReviewerReply(result.reviewText).ok, true);
  assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
});

test('caller-post runtime validation preserves contradictions for bounded reconciliation', () => {
  for (const body of [contradictory, clean.replace('Comment only', 'Request changes')]) {
    assert.equal(validateReviewArtifact(body), body);
    assert.equal(normalizeEffectiveReviewVerdict(validateReviewArtifact(body)), 'request-changes');
  }
});

test('consistent reviews do not reserve or request a re-review', async t => {
  for (const body of [clean, blocking]) {
    const input = dispatch(body);
    const result = await reconcileReviewVerdict({ ...fixture(t), dispatch: input,
      run: () => assert.fail('consistent review must not retry'),
      writeFileAtomicImpl: () => assert.fail('consistent review must not reserve') });
    assert.equal(result, input);
  }
});

test('chunk aggregation preserves contradictory evidence for one whole-review reconciliation', async () => {
  const merged = mergeChunkedAgyReviews([{ reviewText: contradictory }, { reviewText: clean }]);
  assert.equal(normalizeEffectiveReviewVerdict(merged), 'request-changes');
  assert.match(merged, /lost writes/);
  assert.equal(parseReviewFindings(merged).verdict_inconsistent, true);
  const diff = 'diff --git a/src/example.mjs b/src/example.mjs\n--- a/src/example.mjs\n+++ b/src/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  const result = await reviewAgyOversizedInChunks(diff, '', {
    reviewerModel: 'codex', maxBytes: 120000, maxChunks: 2,
    dispatchReviewerModelImpl: async () => dispatch(clean.replace('Comment only', 'Request changes')),
  });
  assert.equal(normalizeEffectiveReviewVerdict(result.reviewText), 'request-changes');
});

test('every prompt stage includes the verdict consistency contract', () => {
  for (const stage of ['first', 'middle', 'last']) {
    assert.match(buildReviewerPromptPrefix({ stage }), /Every blocking issue named in Verdict prose must appear/);
  }
});
