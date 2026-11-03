// REVPOSTSTALL-01: a completed review followed by a non-settling pre-post side
// call must be bounded, preserved with its exact binding and redelivered without
// rerunning the model, and never published late by the stalled process.
import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DELIVERY_DEADLINE_MAX_MS,
  DELIVERY_DEADLINE_NOMINAL_MS,
  PROCESS_DEADLINE_MARGIN_MS,
  REDELIVERY_TOKEN_USAGE_SOURCE,
  createGeneratedReviewDelivery,
  resolveDeliveryDeadlineMs,
} from '../src/reviewer-generated-review-delivery.mjs';
import { createRateLimitThrottle } from '../src/rate-limit-throttle.mjs';
import { writeFileAtomic } from '../src/atomic-write.mjs';
import { reviewerSignalAwareFailureClass } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { createGeminiReviewerProcessDeadline } from '../src/reviewer-process-deadline.mjs';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';

const HEAD = 'b2c5172002a3f090d6e97f062ef35b4f5ddd7ecc';
const OTHER_HEAD = '1a5e19f8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN_SESSION = 'd47f5fa2-ef72-4246-88ae-9abdc967d953';
const RETRY_SESSION = '0b6e2d1c-1111-4222-8333-944455556666';
const DIFF = 'diff --git a/x b/x\n+one\n';
const RAW_REVIEW = '## Summary\nLooks fine.\n\n## Verdict\nComment only\n';
const ATTRIBUTION = {
  version: 1, identity: 'gemini-reviewer', family: 'gemini', reviewerSubject: 'gemini-reviewer-lacey',
  tokenAccountId: null, brokerProvider: null, holderRef: 'holder-a', selectionReason: null,
  evidenceGeneration: null, attemptRef: 'attempt-a', leaseRef: null, leaseGeneration: null,
};

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'revpoststall-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutImpl(timer) { if (timer) timer.cleared = true; },
    fire() { const live = timers.filter((timer) => !timer.cleared); for (const timer of live) { timer.cleared = true; timer.fn(); } },
  };
}

function captureLog() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: { log: (line) => lines.log.push(String(line)), warn: (line) => lines.warn.push(String(line)), error: (line) => lines.error.push(String(line)) },
  };
}

function delivery(rootDir, overrides = {}, { timers = manualTimers(), log = captureLog().log, exits = [] } = {}) {
  let clock = Date.parse('2026-11-03T07:30:35.000Z');
  const instance = createGeneratedReviewDelivery({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 1700,
    headSha: HEAD,
    passKind: 'first-pass',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    reviewAttemptNumber: 1,
    promptStage: 'first',
    verdictOnly: false,
    diff: DIFF,
    sessionUuid: ORIGIN_SESSION,
    reviewDbAttemptNumber: 1,
    env: { ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS: '600000' },
    log,
    now: () => (clock += 1000),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    exitImpl: (code) => exits.push(code),
    ...overrides,
  });
  return instance;
}

function records(rootDir) {
  const dir = join(rootDir, 'data', 'reviewer-generated-reviews');
  return readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

function preserveOriginal(rootDir, options) {
  const original = delivery(rootDir, {}, options);
  assert.equal(original.readReusable(), null);
  assert.equal(original.preserve({
    rawReviewText: RAW_REVIEW,
    dispatch: { reviewText: RAW_REVIEW, needsSanitize: false, chunked: false, elisions: [] },
    execution: { model: 'gemini-3.8-flash', runtime: 'antigravity' },
    reviewerAttribution: ATTRIBUTION,
  }), true);
  return original;
}

function writeThrottledCoreState(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 2,
    buckets: {
      core: {
        resource: 'core',
        remaining: 59,
        resetAt: new Date(Date.now() + 57 * 60 * 1000).toISOString(),
        observedAt: new Date().toISOString(),
      },
    },
  })}\n`);
}

test('REVPOSTSTALL-01 regression: a completed review stuck in a non-settling pre-post throttle defers within the bound, preserved, with no GitHub write', async (t) => {
  const rootDir = tempRoot(t);
  const timers = manualTimers();
  const { lines, log } = captureLog();
  const exits = [];
  const original = preserveOriginal(rootDir, { timers, log, exits });
  const guard = original.armDeliveryDeadline();

  // The witness shape: the shared default-credential core bucket sits below the
  // floor, so the real throttle decides to sleep until reset. The sleep never
  // settles here, standing in for the 57-minute production wait.
  const statePath = join(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
  writeThrottledCoreState(statePath);
  const throttleTelemetry = [];
  const throttle = createRateLimitThrottle({
    env: {}, logger: log, sharedStatePath: statePath,
    sleepImpl: () => new Promise(() => {}),
    recordApiCallImpl: (call) => throttleTelemetry.push(call),
  });
  let wrote = false;
  const delivery$ = guard.track('verdict-mode', throttle.awaitThrottleIfNeeded('core'))
    .then(() => { guard.markWriteStarted(); wrote = true; });
  void delivery$;
  for (let i = 0; i < 20 && throttleTelemetry.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(throttleTelemetry[0]?.category, 'rate_limit_throttle_seconds', 'the real governor entered its sleep');
  assert.equal(throttleTelemetry[0].extra.remaining_at_activation, 59);
  // The governor publishes its sleep as `<state>.throttled.json`, the same
  // operator-visible evidence the deployed witness left.
  for (let i = 0; i < 200 && !existsSync(`${statePath}.throttled.json`); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(JSON.parse(readFileSync(`${statePath}.throttled.json`, 'utf8')).remaining, 59);
  assert.equal(exits.length, 0, 'nothing exits before the bound');

  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 600000);
  timers.fire();

  assert.deepEqual(exits, [1], 'the stalled delivery exits instead of waiting out the throttle');
  assert.equal(wrote, false, 'no GitHub write starts from the stalled process');
  assert.equal(guard.deferred, true);
  const stalled = lines.error.find((line) => line.startsWith('[reviewer-stalled]'));
  assert.match(stalled, /Command timed out after 600000ms \(review delivery deadline before GitHub write; phase=verdict-mode; generated review preserved for exact-head redelivery\)/);
  const receipt = JSON.parse(lines.error.find((line) => line.startsWith('[reviewer-delivery-stall] ')).slice('[reviewer-delivery-stall] '.length));
  assert.equal(receipt.phase, 'verdict-mode');
  assert.equal(receipt.headSha, HEAD);
  assert.equal(receipt.sessionUuid, ORIGIN_SESSION);
  assert.equal(receipt.preserved, true);

  // The existing runtime classifier reads this stderr as the uncharged,
  // claim-releasing reviewer-stalled class.
  const err = Object.assign(new Error('Command failed with exit code 1'), { stderr: lines.error.join('\n'), code: 1 });
  assert.equal(reviewerSignalAwareFailureClass(err, [err.message, err.stderr].join('\n'), 1), 'reviewer-stalled');

  const [{ name, record }] = records(rootDir);
  assert.ok(name.startsWith(`laceyenterprises--adversarial-review-1700-${HEAD}-first-pass-gemini-${ORIGIN_SESSION}`));
  assert.equal(record.deliveryState, 'deferred');
  assert.equal(record.rawReviewText, RAW_REVIEW);
  assert.equal(record.headSha, HEAD);
  assert.equal(record.originSessionUuid, ORIGIN_SESSION);
  assert.equal(record.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(record.deferrals.length, 1);
  assert.equal(record.deferrals[0].phase, 'verdict-mode');
});

test('REVPOSTSTALL-01: the next same-binding claim redelivers the preserved review once, with the original attribution and no model usage', async (t) => {
  const rootDir = tempRoot(t);
  const original = preserveOriginal(rootDir, {});
  original.armDeliveryDeadline();
  const firstTimers = manualTimers();
  void firstTimers;

  const retryTimers = manualTimers();
  const { lines, log } = captureLog();
  const exits = [];
  const retry = delivery(rootDir, { sessionUuid: RETRY_SESSION, reviewDbAttemptNumber: 2 }, { timers: retryTimers, log, exits });
  const dispatch = retry.readReusable();
  assert.ok(dispatch, 'the preserved review is reusable');
  assert.equal(dispatch.rawReviewText, RAW_REVIEW);
  assert.equal(dispatch.reviewText, RAW_REVIEW);
  assert.equal(dispatch.tokenUsage.total, 0);
  assert.equal(dispatch.tokenUsage.source, REDELIVERY_TOKEN_USAGE_SOURCE);
  assert.deepEqual(dispatch.reviewerAttribution, ATTRIBUTION, 'the retry session cannot claim the original run');
  assert.deepEqual(dispatch.execution, { model: 'gemini-3.8-flash', runtime: 'antigravity' });
  assert.equal(dispatch.preservedRedelivery.originSessionUuid, ORIGIN_SESSION);
  assert.ok(lines.log.some((line) => line.includes('"event":"reviewer-generated-review-redelivery"')));

  // The redelivery does not write a second record.
  assert.equal(retry.preserve({ rawReviewText: RAW_REVIEW, dispatch: {} }), true);
  assert.equal(records(rootDir).length, 1);

  const guard = retry.armDeliveryDeadline();
  await guard.track('verdict-mode', Promise.resolve({ verdictMode: 'enforce' }));
  guard.markWriteStarted();
  guard.markWriteStarted();
  retryTimers.fire();
  assert.deepEqual(exits, [], 'a deadline after the write started never exits');
  guard.delivered();
  assert.equal(guard.deferred, false);
  const [{ record }] = records(rootDir);
  assert.equal(record.deliveryState, 'delivered');
  assert.equal(record.deliveredSessionUuid, RETRY_SESSION);
  assert.equal(record.writeStartedSessionUuid, RETRY_SESSION);
  assert.equal(record.redeliveries.length, 1);
  assert.deepEqual(record.deliveryPhases.map((phase) => phase.phase), ['verdict-mode', 'github-write']);
  assert.ok(lines.log.some((line) => line.includes('"event":"reviewer-delivery-phases"')));

  // Delivered means delivered: a later claim does not post it again.
  assert.equal(delivery(rootDir, { sessionUuid: 'third' }).readReusable(), null);
});

test('REVPOSTSTALL-01: exact-head, identity, pass, stage, attempt and diff bindings fail closed', async (t) => {
  const rootDir = tempRoot(t);
  preserveOriginal(rootDir, {});
  const mismatches = {
    headSha: OTHER_HEAD,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    reviewerModel: 'codex',
    passKind: 'rereview',
    promptStage: 'last',
    reviewAttemptNumber: 2,
    verdictOnly: true,
    diff: `${DIFF}+two\n`,
  };
  for (const [field, value] of Object.entries(mismatches)) {
    assert.equal(delivery(rootDir, { [field]: value, sessionUuid: `retry-${field}` }).readReusable(), null, `${field} must bind`);
  }
  assert.equal(delivery(rootDir, { sessionUuid: 'retry-ok' }).readReusable()?.rawReviewText, RAW_REVIEW);
});

test('REVPOSTSTALL-01: a record whose GitHub write started is never redelivered blindly', async (t) => {
  const rootDir = tempRoot(t);
  const timers = manualTimers();
  const exits = [];
  const original = preserveOriginal(rootDir, { timers, exits });
  const guard = original.armDeliveryDeadline();
  guard.markWriteStarted();
  timers.fire();
  assert.deepEqual(exits, []);
  assert.equal(records(rootDir)[0].record.deliveryState, 'write-started');
  const { lines, log } = captureLog();
  assert.equal(delivery(rootDir, { sessionUuid: RETRY_SESSION }, { log }).readReusable(), null);
  assert.ok(lines.warn.some((line) => /reached a GitHub write/.test(line)));
});

test('REVPOSTSTALL-01: tampered bodies and invalid attribution are not reused', async (t) => {
  const rootDir = tempRoot(t);
  preserveOriginal(rootDir, {});
  const dir = join(rootDir, 'data', 'reviewer-generated-reviews');
  const [{ name, record }] = records(rootDir);
  writeFileSync(join(dir, name), JSON.stringify({ ...record, rawReviewText: `${RAW_REVIEW}injected` }));
  assert.equal(delivery(rootDir, { sessionUuid: 'tampered' }).readReusable(), null);
  writeFileSync(join(dir, name), JSON.stringify({ ...record, reviewerAttribution: { ...ATTRIBUTION, extra: 'x' } }));
  assert.equal(delivery(rootDir, { sessionUuid: 'bad-attribution' }).readReusable(), null);
});

test('REVPOSTSTALL-01: the fallback producer is bound, not the pre-dispatch route', async (t) => {
  const rootDir = tempRoot(t);
  const routed = delivery(rootDir, { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' });
  assert.equal(routed.preserve({ rawReviewText: RAW_REVIEW, dispatch: { reviewText: RAW_REVIEW },
    reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' }), true);
  const [{ record }] = records(rootDir);
  assert.equal(record.reviewerModel, 'gemini');
  assert.equal(record.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(delivery(rootDir, { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', sessionUuid: 'x' }).readReusable(), null);
});

test('REVPOSTSTALL-01: without a head nothing is preserved, but delivery stays bounded', async (t) => {
  const rootDir = tempRoot(t);
  const timers = manualTimers();
  const { lines, log } = captureLog();
  const exits = [];
  const headless = delivery(rootDir, { headSha: null }, { timers, log, exits });
  assert.equal(headless.readReusable(), null);
  assert.equal(headless.preserve({ rawReviewText: RAW_REVIEW }), false);
  headless.armDeliveryDeadline().track('token-refresh', new Promise(() => {}));
  timers.fire();
  assert.deepEqual(exits, [1]);
  assert.ok(lines.error.some((line) => /phase=token-refresh; generated review not preserved/.test(line)));
});

test('REVPOSTSTALL-01: a store write failure never fails a completed review', () => {
  const { lines, log } = captureLog();
  const failing = createGeneratedReviewDelivery({
    rootDir: '/nonexistent', repo: 'o/r', prNumber: 1, headSha: HEAD, passKind: 'first-pass',
    reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN', reviewAttemptNumber: 1,
    promptStage: 'first', diff: DIFF, sessionUuid: 's', log,
    writeFileAtomicImpl: () => { throw new Error('disk full'); },
  });
  assert.equal(failing.preserve({ rawReviewText: RAW_REVIEW }), false);
  assert.ok(lines.warn.some((line) => /failed to preserve generated review/.test(line)));
});

test('REVPOSTSTALL-01: the delivery deadline is load-aware, capped and inside the process deadline', () => {
  const calls = [];
  const loadAware = (ms, opts) => { calls.push([ms, opts]); return ms * 3; };
  assert.equal(resolveDeliveryDeadlineMs({ env: {}, loadAwareTimeoutMsImpl: loadAware }), DELIVERY_DEADLINE_NOMINAL_MS * 3);
  assert.deepEqual(calls[0], [DELIVERY_DEADLINE_NOMINAL_MS, { maxMs: DELIVERY_DEADLINE_MAX_MS }]);
  assert.equal(resolveDeliveryDeadlineMs({ env: { ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS: '45000' } }), 45000);
  assert.equal(resolveDeliveryDeadlineMs({ env: { ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS: '0' }, loadAwareTimeoutMsImpl: () => 7000 }), 7000);
  const now = () => 1_000_000;
  assert.equal(resolveDeliveryDeadlineMs({ env: { ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS: '600000' },
    processDeadlineAt: 1_000_000 + PROCESS_DEADLINE_MARGIN_MS + 90_000, now }), 90_000);
  assert.equal(resolveDeliveryDeadlineMs({ env: { ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS: '600000' },
    processDeadlineAt: 1_000_000, now }), 1000, 'an exhausted process budget defers at once, never a fresh timer');
});

test('REVPOSTSTALL-01: the Gemini process deadline exposes its deadline for the delivery bound', () => {
  const unarmed = createGeminiReviewerProcessDeadline({ initialMs: 60_000 });
  assert.equal(unarmed.deadlineAt, null);
  const armed = createGeminiReviewerProcessDeadline({ initialMs: 60_000, now: () => 5_000,
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
  armed.arm();
  assert.equal(armed.deadlineAt, 65_000);
  armed.dispose();
});

test('REVPOSTSTALL-01: postGitHubReview signals the write boundary after its throttle and before the GitHub write', async (t) => {
  const rootDir = tempRoot(t);
  const previous = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(rootDir, 'empty-rate-limit-state.json');
  t.after(() => {
    if (previous === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previous;
  });
  const order = [];
  await reviewerTest.postGitHubReview('laceyenterprises/demo', 42, 'review body', 'GH_CODEX_REVIEWER_TOKEN',
    async (command) => {
      order.push(`exec:${command}`);
      return { stdout: JSON.stringify({ id: 4242, commit_id: HEAD }) };
    },
    {
      rootDir,
      env: { GH_CODEX_REVIEWER_TOKEN: 'ghp_fixture', PATH: '/usr/bin', HOME: '/Users/test' },
      reviewerIdentity: 'codex-reviewer-lacey',
      reviewerHeadSha: HEAD,
      prepareReviewWrite: async () => { order.push('prepare'); },
      onBeforeReviewWrite: () => order.push('write-boundary'),
    });
  assert.deepEqual(order, ['prepare', 'write-boundary', 'exec:gh']);
});

test('REVPOSTSTALL-01: reviewer.mjs preserves before side calls, tracks them under the bound, and marks delivery', () => {
  const source = readFileSync(new URL('../src/reviewer.mjs', import.meta.url), 'utf8');
  const at = (needle, from = 0) => {
    const index = source.indexOf(needle, from);
    assert.notEqual(index, -1, `missing ${needle}`);
    return index;
  };
  const main = at('async function main()');
  const readReusable = at('generatedReview.readReusable()', main);
  assert.ok(readReusable < at('dispatch = preservedDispatch || (useAgyChunkFallback', main));
  const preserved = at('generatedReview.preserve({', main);
  assert.ok(at('DEBUG: review completed', main) < preserved);
  const generated = at('Review generated (', main);
  assert.ok(preserved < generated);
  const armed = at('generatedReview.armDeliveryDeadline({ processDeadlineAt: geminiDeadline.deadlineAt })', main);
  assert.ok(generated < armed);
  const refresh = at("deliveryGuard.track('token-refresh', refreshReviewerTokensForSideCalls(", main);
  const verdict = at("deliveryGuard.track('verdict-mode', fetchCurrentHeadVerdictMode(", main);
  assert.ok(armed < refresh && refresh < verdict && verdict < at('Verdict mode for', main));
  const post = at('await postGitHubReviewWithCapture({', main);
  assert.ok(at('onBeforeReviewWrite: deliveryGuard.markWriteStarted', post) < at('Review posted to', post));
  assert.ok(at('deliveryGuard.delivered()', post) < at('GITHUB POST FAILED', post));
  const postFn = at('async function postGitHubReview(');
  const throttle = at("await awaitThrottleIfNeeded('core', githubCredential({ token }))", postFn);
  const boundary = at('opts.onBeforeReviewWrite?.()', postFn);
  assert.ok(throttle < boundary && boundary < at('postExactHeadReview(', postFn));
});


test('REVPOSTSTALL-01: a failed durable write checkpoint refuses publication and preserves exact-head retry', (t) => {
  const rootDir = tempRoot(t);
  const timers = manualTimers();
  let diskFails = false;
  const original = delivery(rootDir, {
    writeFileAtomicImpl(...args) {
      if (diskFails) throw new Error('fixture store unavailable');
      return writeFileAtomic(...args);
    },
  }, { timers });
  assert.equal(original.preserve({ rawReviewText: RAW_REVIEW, dispatch: { reviewText: RAW_REVIEW } }), true);
  const guard = original.armDeliveryDeadline();
  diskFails = true;
  let publicWrites = 0;
  let failure;
  assert.throws(() => {
    try { guard.markWriteStarted(); } catch (error) { failure = error; throw error; }
    publicWrites += 1;
  }, { code: 'generated-review-write-checkpoint-failed' });
  assert.equal(publicWrites, 0);
  assert.equal(guard.writeStarted, false);
  assert.equal(timers.timers[0].cleared, false, 'deadline still owns a pre-write failure');
  assert.equal(reviewerSignalAwareFailureClass(failure, failure.message, 1), 'reviewer-stalled', 'the saved review is retried without charging a model rerun');
  assert.equal(delivery(rootDir, { sessionUuid: RETRY_SESSION }).readReusable()?.rawReviewText, RAW_REVIEW);
});

test('REVPOSTSTALL-01: a failed delivered update cannot undo the durable write boundary', (t) => {
  const rootDir = tempRoot(t);
  let diskFails = false;
  const original = delivery(rootDir, {
    writeFileAtomicImpl(...args) {
      if (diskFails) throw new Error('fixture delivered update unavailable');
      return writeFileAtomic(...args);
    },
  });
  assert.equal(original.preserve({ rawReviewText: RAW_REVIEW, dispatch: { reviewText: RAW_REVIEW } }), true);
  const guard = original.armDeliveryDeadline();
  guard.markWriteStarted();
  diskFails = true;
  guard.delivered();
  assert.equal(records(rootDir)[0].record.deliveryState, 'write-started');
  assert.equal(delivery(rootDir, { sessionUuid: RETRY_SESSION }).readReusable(), null);
});

test('REVPOSTSTALL-01: an initially unavailable store without a reusable record keeps ordinary delivery', () => {
  const original = createGeneratedReviewDelivery({
    rootDir: '/nonexistent', repo: 'fixture/repo', prNumber: 1, headSha: HEAD,
    passKind: 'first-pass', reviewerModel: 'gemini', botTokenEnv: 'FIXTURE_TOKEN',
    reviewAttemptNumber: 1, promptStage: 'first', diff: DIFF,
    writeFileAtomicImpl() { throw new Error('fixture initial store unavailable'); },
    log: { warn() {}, log() {}, error() {} },
  });
  assert.equal(original.preserve({ rawReviewText: RAW_REVIEW }), false);
  const guard = original.armDeliveryDeadline();
  assert.doesNotThrow(() => guard.markWriteStarted());
  assert.equal(guard.writeStarted, true);
});
