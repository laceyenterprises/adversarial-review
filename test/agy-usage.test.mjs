import './helpers/worker-observation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyStreamEvidence, readAgyUsage } from '../src/agy-usage.mjs';
import { beginReviewerPass, completeReviewerPass, normalizeTokenUsage } from '../src/reviewer-pass-tokens.mjs';
import { reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agy-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, '.gemini', 'antigravity-cli');
  const transcript = join(storeRoot, 'brain', 'synthetic-conversation', '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(transcript, [
    { type: 'USER_INPUT', text: 'synthetic private prompt' },
    { type: 'PLANNER_RESPONSE', input_tokens: 60, output_tokens: 12, cache_read_tokens: 300 },
    { type: 'PLANNER_RESPONSE', input_tokens: 40, output_tokens: 8, cache_read_tokens: 200 },
  ].map(JSON.stringify).join('\n') + '\n');
  const stdout = [
    { event: 'init', conversation_id: 'synthetic-conversation' },
    { event: 'result', conversation_id: 'synthetic-conversation',
      result: { response: '## Adversarial Review\n## Verdict\nApproved',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20,
          thoughtsTokenCount: 8, cachedContentTokenCount: 500, totalTokenCount: 120 } } },
  ].map(JSON.stringify).join('\n');
  return { root, storeRoot, transcript, stdout, model: 'Gemini 3.8 Flash (High)' };
}

test('request counters reach the reviewer-pass record without adding thoughts twice', (t) => {
  const options = fixture(t);
  const usage = readAgyUsage(options);
  assert.equal(usage.total, 120);
  assert.equal(usage.cacheRead, 500);
  assert.equal(usage.reasoning, 8);
  assert.equal(usage.agyUsageMismatch, false);
  assert.equal(usage.source, 'agy-measured');
  assert.equal(usage.model, 'gemini-3.8-flash');
  assert.ok(!JSON.stringify(usage).includes('synthetic private'));
  const key = { repo: 'synthetic/repo', prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(options.root, { ...key, reviewerClass: 'gemini', reviewerModel: usage.model });
  const pass = completeReviewerPass(options.root, { ...key, status: 'completed', tokenUsage: usage });
  assert.equal(pass.token_input, 100);
  assert.equal(pass.token_output, 20);
  assert.equal(pass.token_total, 120);
  assert.equal(pass.token_source, 'agy-measured');
  assert.equal(JSON.parse(pass.metadata_json).agySessionTotal, 120);
  assert.equal(normalizeTokenUsage({ input: 100, output: 20, reasoning: 8, source: 'agy-measured' }).total, 120);
  const unknown = { ...key, attemptNumber: 2 };
  beginReviewerPass(options.root, { ...unknown, reviewerClass: 'gemini', reviewerModel: 'unknown' });
  const unpriced = completeReviewerPass(options.root, {
    ...unknown, status: 'completed', tokenUsage: { ...usage, model: 'unknown' },
  });
  assert.equal(unpriced.token_cost_usd, null);
});

test('missing transcript retains session totals and unavailable evidence fails open', (t) => {
  const options = fixture(t);
  rmSync(options.transcript);
  assert.equal(readAgyUsage(options).total, 120);
  assert.equal(readAgyUsage(options).agyRequestTotal, null);
  const native = JSON.stringify({ event: 'result', conversation_id: 'synthetic-conversation',
    result: { usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 8,
      cache_read_tokens: 500, total_tokens: 120 } } });
  const nativeUsage = readAgyUsage({ ...options, stdout: native });
  assert.equal(nativeUsage.total, 120);
  assert.equal(nativeUsage.reasoning, 8);
  assert.equal(nativeUsage.cacheRead, 500);
  assert.equal(readAgyUsage({ ...options, stdout: 'synthetic plain review' }), null);
  assert.equal(agyStreamEvidence(options.stdout).response.includes('Approved'), true);
});

test('mismatch, unsafe join and dedicated-account counter transport', (t) => {
  const options = fixture(t);
  const usage = readAgyUsage({ ...options, requestCounts: { input: 101, output: 20, cacheRead: 500 } });
  assert.equal(usage.total, 121);
  assert.equal(usage.agyUsageMismatch, true);
  assert.equal(readAgyUsage({ ...options, stdout: options.stdout.replaceAll('synthetic-conversation', '../escape') }), null);
});

test('Gemini reviewer stream response delivers measured usage to its caller', async (t) => {
  const options = fixture(t);
  const result = await reviewWithGemini('+synthetic diff\n', '', {
    resolveGeminiRuntimeImpl: () => 'antigravity',
    agyIdentity: null,
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic' }),
    materializeGeminiCheckoutSessionImpl: ({ env }) => ({ env: { ...env, HOME: options.root }, cleanup() {} }),
    purgeStaleGeminiReviewerSessionDirsImpl: () => {},
    releaseGeminiCredentialCheckoutImpl: async () => {},
    assertAgyAuthImpl: async () => {},
    spawnAgyReviewImpl: async () => ({ stdout: options.stdout, stderr: '' }),
  });
  assert.equal(result.tokenUsage.total, 120);
  assert.equal(result.tokenUsage.source, 'agy-measured');
  assert.ok(result.reviewText.includes('Approved'));
  assert.ok(harness.buildAgyReviewArgs({ model: options.model, prompt: 'synthetic' }).includes('stream-json'));
});
