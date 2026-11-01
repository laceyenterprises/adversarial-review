import './helpers/worker-observation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyReviewText, agyStreamEvidence, readAgyUsage } from '../src/agy-usage.mjs';
import { beginReviewerPass, completeReviewerPass, normalizeTokenUsage } from '../src/reviewer-pass-tokens.mjs';
import { loadReviewerPricingTable } from '../src/reviewer-token-pricing.mjs';
import { reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agy-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, '.gemini', 'antigravity-cli');
  const transcript = join(storeRoot, 'brain', 'synthetic-conversation', '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(transcript, [
    { type: 'USER_INPUT', text: 'synthetic private prompt' },
    { type: 'PLANNER_RESPONSE', input_tokens: 60, output_tokens: 12, cache_read_tokens: 30 },
    { type: 'PLANNER_RESPONSE', input_tokens: 40, output_tokens: 8, cache_read_tokens: 20 },
  ].map(JSON.stringify).join('\n') + '\n');
  const stdout = [
    { event: 'init', conversation_id: 'synthetic-conversation' },
    { event: 'result', conversation_id: 'synthetic-conversation',
      result: { response: '## Adversarial Review\n## Verdict\nApproved',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20,
          thoughtsTokenCount: 8, cachedContentTokenCount: 50, totalTokenCount: 120 } } },
  ].map(JSON.stringify).join('\n');
  return { root, storeRoot, transcript, stdout, model: 'Gemini 3.8 Flash (High)' };
}

test('request counters reach the reviewer-pass record without adding thoughts twice', (t) => {
  const options = fixture(t);
  const usage = readAgyUsage(options);
  assert.equal(usage.total, 120);
  assert.equal(usage.input, 50);
  assert.equal(usage.cacheRead, 50);
  assert.equal(usage.reasoning, 8);
  assert.equal(usage.agyUsageMismatch, false);
  assert.equal(usage.source, 'agy-measured');
  assert.equal(usage.model, 'gemini-3.8-flash');
  assert.ok(!JSON.stringify(usage).includes('synthetic private'));
  const key = { repo: 'synthetic/repo', prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  const pricingFile = join(options.root, 'pricing.json');
  writeFileSync(pricingFile, JSON.stringify({
    schemaVersion: 1, unit: 'usd_per_1m_tokens',
    fallback: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, estimated: true },
    models: { 'gemini-3.8-flash': { input: 2, output: 4, cache_read: 0.2, cache_write: 2 } },
  }));
  beginReviewerPass(options.root, { ...key, reviewerClass: 'gemini', reviewerModel: options.model });
  const pass = completeReviewerPass(options.root, { ...key, status: 'completed', tokenUsage: usage,
    pricingTable: loadReviewerPricingTable({ file: pricingFile, env: {} }) });
  assert.equal(pass.token_input, 50);
  assert.equal(pass.token_output, 20);
  assert.equal(pass.token_total, 120);
  assert.equal(pass.token_source, 'agy-measured');
  assert.equal(pass.token_cost_usd, 0.00019);
  assert.equal(JSON.parse(pass.metadata_json).agySessionTotal, 120);
  assert.equal(normalizeTokenUsage({ input: 50, cacheRead: 50, output: 20, reasoning: 8, source: 'agy-measured' }).total, 120);
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
      cache_read_tokens: 50, total_tokens: 120 } } });
  const nativeUsage = readAgyUsage({ ...options, stdout: native });
  assert.equal(nativeUsage.total, 120);
  assert.equal(nativeUsage.reasoning, 8);
  assert.equal(nativeUsage.input, 50);
  assert.equal(nativeUsage.cacheRead, 50);
  assert.equal(readAgyUsage({ ...options, stdout: 'synthetic plain review' }), null);
  assert.equal(agyStreamEvidence(options.stdout).response.includes('Approved'), true);
});

test('mismatch, unsafe join and dedicated-account counter transport', (t) => {
  const options = fixture(t);
  const usage = readAgyUsage({ ...options, requestCounts: { input: 101, output: 20, cacheRead: 50 } });
  assert.equal(usage.total, 121);
  assert.equal(usage.agyUsageMismatch, true);
  assert.equal(readAgyUsage({ ...options, stdout: options.stdout.replaceAll('synthetic-conversation', '../escape') }), null);
});

test('Gemini reviewer stream response delivers measured usage to its caller', async (t) => {
  const options = fixture(t);
  const result = await reviewWithGemini('+synthetic diff\n', '', {
    env: { ...process.env, HOME: options.root, AGENT_OS_CONFIG_PATH: '/dev/null' },
    resolveGeminiRuntimeImpl: () => 'antigravity',
    agyIdentity: null,
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic' }),
    materializeGeminiCheckoutSessionImpl: ({ env }) => {
      const session = harness.materializeGeminiCheckoutSession({
        checkout: { oauthCreds: {} }, env, sessionParent: join(options.root, 'sessions'),
      });
      const transcript = join(session.env.GEMINI_HOME, 'antigravity-cli', 'brain',
        'synthetic-conversation', '.system_generated', 'logs', 'transcript.jsonl');
      mkdirSync(join(transcript, '..'), { recursive: true });
      copyFileSync(options.transcript, transcript);
      return session;
    },
    purgeStaleGeminiReviewerSessionDirsImpl: () => {},
    releaseGeminiCredentialCheckoutImpl: async () => {},
    assertAgyAuthImpl: async () => {},
    spawnAgyReviewImpl: async () => ({ stdout: options.stdout, stderr: '' }),
  });
  assert.equal(result.tokenUsage.total, 120);
  assert.equal(result.tokenUsage.source, 'agy-measured');
  assert.equal(result.tokenUsage.agyRequestTotal, 120);
  assert.ok(result.reviewText.includes('Approved'));
  assert.ok(harness.buildAgyReviewArgs({ model: options.model, prompt: 'synthetic' }).includes('stream-json'));
});

test('invalid helper counters retain measured stream totals', (t) => {
  const options = fixture(t);
  rmSync(options.transcript);
  for (const requestCounts of [{}, { error: 'missing' }, { input: 0, output: 0 },
    { input: -1, output: 20 }, { input: 100, output: 20, cacheRead: 101 },
    { input: Number.MAX_SAFE_INTEGER, output: 20 }, { input: 100.5, output: 20 }]) {
    const usage = readAgyUsage({ ...options, requestCounts });
    assert.equal(usage.total, 120);
    assert.equal(usage.input, 50);
    assert.equal(usage.agyRequestTotal, null);
  }
});

test('oversized or malformed transcripts fall back without partial request totals', (t) => {
  const options = fixture(t);
  truncateSync(options.transcript, 8 * 1024 * 1024 + 1);
  assert.equal(readAgyUsage(options).agyRequestTotal, null);
  assert.equal(readAgyUsage(options).total, 120);
  writeFileSync(options.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 3 }));
  assert.equal(readAgyUsage(options).agyRequestTotal, null);
});

test('stream diagnostics with no result preserve timeout and model-refusal classification', () => {
  for (const event of [
    { event: 'error', error: { message: 'Error: timed out waiting for response' } },
    { event: 'message', message: { content: [{ text: 'Error: timed out waiting for response' }] } },
  ]) {
    assert.throws(() => harness.sanitizeAgyReviewOutput(agyReviewText(JSON.stringify(event))),
      /returned error output instead of a review/u);
  }
  const stdout = JSON.stringify({ event: 'error', error: {
    message: 'Error: invalid model selection: model Gemini Missing is not recognized as a known model\nAvailable models:\n  Gemini 3.8 Flash (High)',
  } });
  assert.throws(() => harness.sanitizeAgyReviewOutput(agyReviewText(stdout)),
    (err) => err.failureClass === 'reviewer-model-unavailable');
});

test('real subprocess retries a rejected telemetry flag once and delivers plain review', async (t) => {
  const options = fixture(t);
  const cli = join(options.root, 'agy-stub');
  const calls = join(options.root, 'calls.jsonl');
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('--output-format')) {
  console.error("error: unknown option '--output-format'");
  process.exitCode = 2;
} else console.log('## Adversarial Review\\n## Verdict\\nApproved');
`);
  chmodSync(cli, 0o700);
  const result = await harness.spawnAgyReview({
    agyCli: cli, prompt: 'synthetic prompt', model: options.model, env: process.env,
    cwd: options.root, timeout: 10_000, printTimeoutMs: 1000,
  });
  assert.ok(result.stdout.includes('Approved'));
  const attempts = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].includes('stream-json'));
  assert.ok(!attempts[1].includes('--output-format'));
  assert.equal(attempts[1].at(-1), 'synthetic prompt');
  assert.equal(attempts[1][1], options.model);
});

test('telemetry fallback never replays unrelated failures or repeats a rejected plain invocation', async () => {
  for (const message of ['Error: model unavailable', "unknown option '--output-format'"]) {
    let calls = 0;
    await assert.rejects(harness.spawnAgyReview({
      prompt: 'synthetic', model: 'synthetic', env: {}, timeout: 1000,
      spawnWithInputImpl: async () => { calls += 1; throw new Error(message); },
    }), { message });
    assert.equal(calls, message.includes('--output-format') ? 2 : 1);
  }
});

test('pinned identity wrapper flag rejection retries with the same private prompt transport', async () => {
  const attempts = [];
  const result = await harness.spawnAgyReview({
    prompt: 'synthetic private prompt', model: 'Gemini 3.8 Flash (High)',
    identity: { user: 'synthetic-reviewer', cwd: '/tmp', workspaceDir: '/tmp' },
    env: {}, timeout: 10_000,
    spawnWithInputImpl: async (command, args, options) => {
      attempts.push({ command, args, options });
      if (args.includes('--output-format')) {
        writeFileSync(options.stderrPath, "error: unsupported argument '--output-format'");
        throw new Error('pinned wrapper exited 2');
      }
      writeFileSync(options.stdoutPath, '## Adversarial Review\n## Verdict\nApproved');
      return { stdout: '', stderr: '' };
    },
  });
  assert.ok(result.stdout.includes('Approved'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].command, attempts[1].command);
  for (const attempt of attempts) {
    assert.ok(attempt.args.includes('--prompt-stdin'));
    assert.ok(!attempt.args.includes('synthetic private prompt'));
    assert.equal(attempt.options.input, 'synthetic private prompt');
  }
  assert.ok(!attempts[1].args.includes('--output-format'));
  assert.ok(attempts[1].options.timeout <= attempts[0].options.timeout);
});
