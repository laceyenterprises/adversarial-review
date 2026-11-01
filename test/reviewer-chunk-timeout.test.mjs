import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as timeouts from '../src/reviewer-timeout.mjs';
import { resolveAgyOversizedReviewRoute, reviewAgyOversizedInChunks, reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';
import { reviewerExecutionFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';
import { underMaxLoad, MAX_TIMER_DELAY_MS } from './helpers/load-time-kit.mjs';
import os from 'node:os';

const diff = 'diff --git a/sample.mjs b/sample.mjs\n--- a/sample.mjs\n+++ b/sample.mjs\n@@ -0,0 +1,9000 @@\n' + '+synthetic content\n'.repeat(9000);

function underObservedLoad(t) {
  underMaxLoad(t);
  // Full CPU corroboration at this synthetic load yields the observed call
  // budget after rounding, without reading host load or provider state.
  const multiplier = 5228726.5 / timeouts.DEFAULT_REVIEWER_TIMEOUT_MS;
  t.mock.method(os, 'loadavg', () => [os.cpus().length * (1 + (multiplier - 1) / 2.5), 0, 0]);
}

test('LAC-2100: observed six-chunk allocation fits without inflating the aggregate cap', t => {
  underObservedLoad(t);
  assert.equal(timeouts.resolveAgyReviewerSubprocessTimeoutMs({}), 5228727);
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 6, promptBytes: 694487, env: {} });
  assert.equal(plan.requestedPerChunkTimeoutMs, 5228727);
  assert.equal(plan.requiredMs, 31492362, 'retain the original unbounded sizing diagnostic');
  assert.equal(plan.promptBytes, 694487);
  assert.equal(plan.capMs, 21600000);
  assert.equal(plan.perChunkTimeoutMs, 3530000);
  assert.equal(plan.timeoutMs, 21300000);
  assert.equal(timeouts.resolveGeminiReviewerProcessTimeoutMs({}, { plan }), plan.capMs);
});

test('LAC-2100: observed prompt size and delivery budget run all six bounded Gemini chunks', async t => {
  underObservedLoad(t);
  const diff = 'diff --git a/sample.mjs b/sample.mjs\n--- a/sample.mjs\n+++ b/sample.mjs\n@@ -0,0 +1,31000 @@\n'
    + '+synthetic content\n'.repeat(31000);
  // Route sizing reserves 1024 bytes below the argv setting.
  const env = { ADVERSARIAL_REVIEW_AGY_ARGV_MAX_BYTES: '234464' };
  const routeFor = extraContext => resolveAgyOversizedReviewRoute({
    reviewerModel: 'gemini', geminiRuntime: 'antigravity', diff, extraContext, env,
  });
  // Match the incident's size, not its source content. Repeated context is why
  // ceil(promptBytes / deliveryBytes) does not predict the actual chunk count.
  const context = 'x'.repeat(694487 - routeFor('').promptBytes);
  const route = routeFor(context);
  assert.equal(route.promptBytes, 694487);
  assert.equal(route.maxBytes, 233440);
  let plan;
  let calls = 0;
  const result = await reviewAgyOversizedInChunks(diff, context, {
    env, maxBytes: route.maxBytes, promptBytes: route.promptBytes,
    onChunkPlan: value => { plan = value; },
    reviewWithGeminiImpl: async (_diff, _context, options) => {
      assert.equal(options.timeoutMs, 3530000);
      assert.equal(options.signal.aborted, false);
      calls += 1;
      return { reviewText: '## Verdict\nComment only' };
    },
  });
  assert.equal(plan.chunkCount, 6);
  assert.equal(calls, 6);
  assert.equal(result.chunks.length, 6);
  for (const chunk of result.chunks) assert.ok(chunk.promptBytes <= route.maxBytes);
});

for (const maxMultiplier of [1, 6, 20]) {
  test(`LAC-2100: bounded chunk allocations at load x${maxMultiplier}`, t => {
    underMaxLoad(t, { maxMultiplier });
    const requested = timeouts.resolveAgyReviewerSubprocessTimeoutMs({});
    for (const chunkCount of [1, 2, 3, 6, 17, 18]) {
      const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount, env: {} });
      assert.equal(plan.perChunkTimeoutMs, Math.min(requested, Math.floor((plan.capMs
        - timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS - timeouts.REVIEWER_PROCESS_SLACK_MS) / chunkCount)));
      assert.equal(plan.requiredMs, requested * chunkCount + timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS);
      assert.equal(plan.timeoutMs, plan.perChunkTimeoutMs * chunkCount + timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS);
      assert.equal(timeouts.resolveGeminiReviewerProcessTimeoutMs({}, { plan }),
        plan.timeoutMs + timeouts.REVIEWER_PROCESS_SLACK_MS);
      assert.ok(plan.timeoutMs + timeouts.REVIEWER_PROCESS_SLACK_MS <= plan.capMs);
    }
  });
}

test('LAC-2100: finite integer budgets at timer saturation and the minimum feasible cap', () => {
  const huge = {
    ADVERSARIAL_REVIEWER_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS),
    ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS),
    ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: String(Number.MAX_SAFE_INTEGER),
  };
  for (const chunkCount of [1, 6, 18]) {
    const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount, env: huge });
    assert.equal(plan.capMs, MAX_TIMER_DELAY_MS);
    assert.equal(plan.requestedPerChunkTimeoutMs, MAX_TIMER_DELAY_MS);
    for (const key of ['perChunkTimeoutMs', 'timeoutMs', 'capMs', 'requiredMs']) {
      assert.ok(Number.isSafeInteger(plan[key]) && plan[key] > 0, key);
    }
    assert.ok(plan.timeoutMs + timeouts.REVIEWER_PROCESS_SLACK_MS <= MAX_TIMER_DELAY_MS);
  }
  const slack = timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS + timeouts.REVIEWER_PROCESS_SLACK_MS;
  const env = { ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: String(slack + 6) };
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 6, env });
  assert.equal(plan.perChunkTimeoutMs, 1);
  assert.equal(plan.timeoutMs + timeouts.REVIEWER_PROCESS_SLACK_MS, plan.capMs);
  for (const chunkCount of [7, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => timeouts.resolveAgyChunkTimeoutPlan({ chunkCount, env }),
      error => error.name === 'ReviewerChunkBudgetExceededError'
        && error.plan.promptBytes === null && Number.isFinite(error.plan.requiredMs)
        && error.plan.minimumCapMs > error.plan.capMs && /minimumCapMs=\d+/.test(error.message));
  }
  for (const chunkCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => timeouts.resolveAgyChunkTimeoutPlan({ chunkCount, env: {} }), TypeError);
  }
});

test('CHUNKTIME-01: N chunks receive N per-call budgets plus slack within the cap', () => {
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 4, env: {} });
  assert.ok(plan.timeoutMs >= 4 * plan.perChunkTimeoutMs);
  assert.ok(plan.timeoutMs <= plan.capMs);
  assert.equal(plan.timeoutMs, 4 * plan.perChunkTimeoutMs + timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS);
});

test('CHUNKTIME-01: over-cap plan refuses before the first credential checkout and is non-infra', async () => {
  await assert.rejects(reviewAgyOversizedInChunks(diff, '', {
    env: { ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: '1' },
    maxBytes: 60000,
    reviewWithGeminiImpl: () => assert.fail('no identity time may be spent'),
  }), (error) => {
    assert.match(error.message, /chunks=\d+.*perChunkTimeoutMs=\d+.*requiredMs=\d+.*capMs=1/);
    const failureClass = classifyReviewerFailure(error.message, reviewerExecutionFailureExitCode(error));
    assert.equal(failureClass, 'reviewer-chunk-budget-exceeded');
    assert.equal(infraRecoverableFailureClass({ failure_message: `[${failureClass}] ${error.message}` }), null);
    const rootDir = mkdtempSync(join(tmpdir(), 'chunk-budget-'));
    const writes = [];
    try {
      settleReviewerAttempt({ rootDir, repoPath: 'example/project', prNumber: 1,
        result: { ok: false, failureClass, error: error.message }, leaseRecoveryEnabled: true,
        statements: {
          markFailed: { run: (...args) => writes.push(args) },
          releaseReviewLease: { run: () => assert.fail('must remain terminal') },
          getReviewRow: { get: () => assert.fail('must not consult or charge infra attempts') },
        }, log: { warn() {}, error() {}, info() {} },
      });
      assert.equal(writes.length, 1);
      assert.match(writes[0][1], /chunks=/);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
    return true;
  });
});

test('CHUNKTIME-01: chunk execution receives the plan deadline and an abort signal', async () => {
  let plan;
  let calls = 0;
  const result = await reviewAgyOversizedInChunks(diff, '', {
    env: {}, maxBytes: 60000,
    onChunkPlan: (value) => { plan = value; },
    reviewWithGeminiImpl: async (_diff, _context, options) => {
      assert.ok(plan.chunkCount > 1);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.timeoutMs, plan.perChunkTimeoutMs);
      calls += 1;
      return { reviewText: '## Verdict\nComment only' };
    },
  });
  assert.equal(calls, result.chunks.length);
  assert.equal(plan.chunkCount, calls);
});

test('CHUNKTIME-01: timeout stops fake agy and releases its credential lease in the same tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  await assert.rejects(reviewWithGemini('+synthetic', '', {
    timeoutMs: 100, agyIdentity: null,
    resolveGeminiRuntimeImpl: () => 'antigravity',
    purgeStaleGeminiReviewerSessionDirsImpl: () => {},
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic-checkout' }),
    materializeGeminiCheckoutSessionImpl: () => ({ env: {} }),
    assertAgyAuthImpl: async () => {},
    releaseGeminiCredentialCheckoutImpl: async () => { events.push('released'); },
    spawnAgyReviewImpl: async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener('abort', () => events.push('stopped'), { once: true });
      t.mock.timers.tick(100);
      signal.throwIfAborted();
    },
  }));
  assert.deepEqual(events, ['stopped', 'released']);
});

for (const scenario of [
  { name: 'observed saturated load', observedLoad: true, allocation: 3530000, printSeconds: 3500 },
  { name: 'twenty idle chunks', allocation: 1059000, printSeconds: 1029 },
  { name: 'fractional seconds', allocation: 1059123, printSeconds: 1029 },
  { name: 'lower configured print budget', allocation: 1200000, printSeconds: 1140 },
  { name: 'CLI minimum', allocation: 100, printSeconds: 1 },
  { name: 'no explicit allocation', allocation: null, printSeconds: 1140 },
]) {
  test(`LAC-2100: agy print timeout respects ${scenario.name}`, async t => {
    // These cases check budget conversion; the deadline test above exercises expiry.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    if (scenario.observedLoad) underObservedLoad(t);
    else underMaxLoad(t, { maxMultiplier: 1 });
    let calls = 0;
    let releases = 0;
    const result = await reviewWithGemini('+synthetic', '', {
      timeoutMs: scenario.allocation, agyIdentity: null,
      resolveGeminiRuntimeImpl: () => 'antigravity',
      purgeStaleGeminiReviewerSessionDirsImpl: () => {},
      checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic-checkout' }),
      materializeGeminiCheckoutSessionImpl: () => ({ env: {}, cleanup() {} }),
      assertAgyAuthImpl: async () => {},
      releaseGeminiCredentialCheckoutImpl: async () => { releases += 1; },
      spawnAgyReviewImpl: options => harness.spawnAgyReview({ ...options,
        spawnWithInputImpl: async (_command, args, spawnOptions) => {
          calls += 1;
          assert.equal(args[args.indexOf('--print-timeout') + 1], `${scenario.printSeconds}s`);
          const allocation = scenario.allocation ?? timeouts.resolveAgyReviewerSubprocessTimeoutMs({});
          if (allocation >= 31000) {
            assert.ok(scenario.printSeconds * 1000 + timeouts.AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS <= allocation);
            assert.equal(spawnOptions.timeout, allocation);
          }
          return { stdout: '## Verdict\nComment only' };
        },
      }),
    });
    assert.match(result.reviewText, /Comment only/);
    assert.equal(calls, 1);
    assert.equal(releases, 1);
  });
}


test('CHUNKTIME-01: termination forwards an abort to detached agy before self termination', async () => {
  const events = [];
  harness.configureGeminiSignalReleaseForTest({
    killImpl: () => events.push('self-signal'),
  });
  try {
    await assert.rejects(harness.spawnAgyReview({
      prompt: 'synthetic review', env: {},
      spawnWithInputImpl: async (_command, _args, options) => {
        assert.equal(options.killGraceMs, 0);
        options.signal.addEventListener('abort', () => events.push('stopped'), { once: true });
        await harness.releaseActiveGeminiCheckoutsForSignal('SIGTERM');
        options.signal.throwIfAborted();
      },
    }));
    assert.deepEqual(events, ['stopped', 'self-signal']);
  } finally { harness.resetGeminiSignalReleaseForTest(); }
});

test('CHUNKTIME-01: the plan timer aborts a late chunk without rerunning earlier chunks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let plan;
  let calls = 0;
  await assert.rejects(reviewAgyOversizedInChunks(diff, '', {
    env: {}, maxBytes: 60000,
    onChunkPlan: (value) => { plan = value; },
    reviewWithGeminiImpl: async (_diff, _context, { signal }) => {
      calls += 1;
      if (calls === 1) return { reviewText: '## Verdict\nComment only' };
      t.mock.timers.tick(plan.timeoutMs);
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    },
  }), /Command timed out after .*chunks=/);
  assert.equal(calls, 2);
});

test('CHUNKTIME-01: Argus outer deadline covers its sequential model fallback plan', async () => {
  const { resolveArgusReviewChildTimeoutMs } = await import('../src/argus-security-drain.mjs');
  const { resolveReviewerCeilingConfig } = await import('../src/reviewer-timeout-model.mjs');
  const env = { ADVERSARIAL_ARGUS_REVIEWER_MODELS: 'claude,gemini,codex' };
  const required = 2 * resolveReviewerCeilingConfig(env).max * 1000
    + timeouts.resolveAgyReviewerSubprocessTimeoutMs(env);
  assert.ok(resolveArgusReviewChildTimeoutMs(env) >= required);
});

test('CHUNKTIME-01: native Gemini retries share one call budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  await assert.rejects(reviewWithGemini('+synthetic', '', {
    timeoutMs: 100, agyIdentity: null,
    resolveGeminiRuntimeImpl: () => 'cli',
    assertOAuthImpl: async () => {},
    retryDelaysMs: [1],
    sleepImpl: async () => { t.mock.timers.tick(100); },
    spawnGeminiReviewImpl: async () => {
      calls += 1;
      throw new Error('HTTP 503 service unavailable');
    },
  }), /Command timed out after 100ms/);
  assert.equal(calls, 1);
});


test('CHUNKTIME-01: prompt bytes include context and repeated context increases chunk count', async () => {
  const context = 'synthetic context\n'.repeat(500);
  const route = resolveAgyOversizedReviewRoute({ reviewerModel: 'gemini', geminiRuntime: 'antigravity',
    diff, extraContext: context, env: {} });
  assert.equal(route.diffBytes, Buffer.byteLength(diff));
  assert.equal(route.contextBytes, Buffer.byteLength(context));
  assert.ok(route.promptOverheadBytes > 0);
  assert.equal(route.promptBytes, route.diffBytes + route.contextBytes + route.promptOverheadBytes);
  const counts = [];
  for (const extraContext of ['', context]) {
    await reviewAgyOversizedInChunks(diff, extraContext, {
      env: {}, maxBytes: 60000,
      onChunkPlan: (plan) => counts.push(plan.chunkCount),
      reviewWithGeminiImpl: async () => ({ reviewText: '## Verdict\nComment only' }),
    });
  }
  assert.ok(counts[1] > counts[0], `${counts}`);
});


test('CHUNKTIME-01: the outer Gemini runtime defaults to one call and honors an explicit bound', async () => {
  const { createCliDirectReviewerRuntimeAdapter } = await import('../src/adapters/reviewer-runtime/cli-direct/index.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'chunk-runtime-'));
  const seen = [];
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir,
      preflightImpl: async () => ({ ok: true }),
      spawnCapturedImpl: async (_command, _args, options) => {
        seen.push(options.timeout);
        return { stdout: '', stderr: '' };
      },
    });
    for (const [sessionUuid, timeoutMs] of [['synthetic-default', undefined], ['synthetic-explicit', 100]]) {
      await adapter.spawnReviewer({ model: 'gemini', prompt: '', timeoutMs, sessionUuid,
        subjectContext: { domainId: 'code-pr', repo: 'example/project', prNumber: 1 } });
    }
    assert.equal(seen[0], timeouts.resolveGeminiReviewerProcessTimeoutMs());
    assert.equal(seen[1], 100);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});


test('GEMTIMEOUT-01: parent timer and persisted lease receive a saturated plan without rescaling', async t => {
  underObservedLoad(t);
  const { createCliDirectReviewerRuntimeAdapter } = await import('../src/adapters/reviewer-runtime/cli-direct/index.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'plan-runtime-'));
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 6, env: {} });
  const updates = [];
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir,
      preflightImpl: async () => ({ ok: true }),
      spawnCapturedImpl: async (_command, _args, options) => {
        assert.equal(options.timeout, timeouts.resolveGeminiReviewerProcessTimeoutMs());
        assert.equal(options.onMessage({ type: 'unrelated' }), undefined);
        assert.equal(options.onMessage({ type: 'gemini-chunk-plan', plan }),
          timeouts.resolveGeminiReviewerProcessTimeoutMs({}, { plan }));
        assert.equal(updates.length, 1, 'lease is persisted before timer extension');
        assert.equal(options.onMessage({ type: 'gemini-chunk-plan', plan }), undefined);
        assert.throws(() => options.onMessage({ type: 'gemini-chunk-plan', plan: { chunkCount: 0 } }), /Invalid/);
        return { stdout: '', stderr: '' };
      },
    });
    await adapter.spawnReviewer({ model: 'gemini', sessionUuid: 'synthetic-plan', prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'example/project', prNumber: 1 },
      onReviewerTimeoutPlan: update => updates.push(update),
    });
    assert.deepEqual(updates, [{ sessionUuid: 'synthetic-plan', timeoutMs: plan.timeoutMs + timeouts.REVIEWER_PROCESS_SLACK_MS }]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});


test('GEMTIMEOUT-01: saturated plan updates orphan expiry and fences replacement or terminal rows', async t => {
  underObservedLoad(t);
  const { default: Database } = await import('better-sqlite3');
  const { extendReviewerLeaseForPlan, computeReviewerLeaseExpiryAt } = await import('../src/reviewer-lease.mjs');
  const { shouldReconcileStaleReviewerSession } = await import('../src/reviewer-orphan-reconcile.mjs');
  const db = new Database(':memory:');
  const startedAt = '2026-01-01T00:00:00.000Z';
  const initialMs = timeouts.resolveGeminiReviewerProcessTimeoutMs({});
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 6, env: {} });
  const timeoutMs = timeouts.resolveGeminiReviewerProcessTimeoutMs({}, { plan });
  try {
    db.exec(`CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, reviewer_session_uuid TEXT,
      review_status TEXT, pr_state TEXT, reviewer_started_at TEXT, reviewer_timeout_ms INTEGER,
      reviewer_lease_expires_at TEXT)`);
    db.prepare('INSERT INTO reviewed_prs VALUES (?, 1, ?, ?, ?, ?, ?, ?)').run(
      'example/project', 'synthetic-session', 'reviewing', 'open', startedAt, initialMs,
      computeReviewerLeaseExpiryAt(startedAt, initialMs));
    const update = { repo: 'example/project', prNumber: 1, sessionUuid: 'synthetic-session', timeoutMs };
    assert.equal(extendReviewerLeaseForPlan(db, { ...update, sessionUuid: 'stale-session' }), false);
    assert.equal(extendReviewerLeaseForPlan(db, update), true);
    const row = db.prepare('SELECT * FROM reviewed_prs').get();
    assert.equal(row.reviewer_timeout_ms, timeoutMs);
    assert.equal(row.reviewer_lease_expires_at, computeReviewerLeaseExpiryAt(startedAt, timeoutMs));
    const options = { leaseRecoveryEnabled: true, probeGroupAliveImpl: () => true };
    row.reviewer_pgid = 12345;
    assert.equal(shouldReconcileStaleReviewerSession(row, new Date(Date.parse(startedAt) + initialMs), options), false);
    assert.equal(shouldReconcileStaleReviewerSession(row, new Date(Date.parse(startedAt) + timeoutMs), options), true);
    assert.equal(extendReviewerLeaseForPlan(db, { ...update, timeoutMs: initialMs }), true);
    assert.equal(db.prepare('SELECT reviewer_timeout_ms FROM reviewed_prs').get().reviewer_timeout_ms, timeoutMs);
    for (const change of ["review_status = 'posted'", "review_status = 'reviewing', pr_state = 'merged'", "pr_state = 'closed'"]) {
      db.exec(`UPDATE reviewed_prs SET ${change}`);
      assert.equal(extendReviewerLeaseForPlan(db, update), false);
    }
  } finally { db.close(); }
});
