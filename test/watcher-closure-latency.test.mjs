import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { POSTED_REVIEW_CONCURRENCY, createPostedReviewFairnessState,
  runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { createNoProgressLaneGate, handlePostedReviewRow, preparePostedReviewHandlers,
  runQueuedReviewAdoptionPhase } from '../src/posted-review-row.mjs';
import { readNoProgressLane, recordNoProgressLaneRun, recordNoProgressLaneSkip } from '../src/watcher-no-progress-lane.mjs';
import { withClosureEvaluationReadCache } from '../src/closure-evaluation-cache.mjs';
import { fetchMergeAgentCandidate } from '../src/merge-agent-candidate.mjs';
import { fetchMergeAgentCandidateSnapshot } from '../src/merge-agent-candidate-snapshot.mjs';
import { fetchPullRequestHeadAndState } from '../src/github-api.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { readAdapterPrRollup, readAdapterHeadAndState,
  withGitHubAdapterReadTick } from '../src/github-adapter-client.mjs';
import { recordFinalReviewHammerLatency, finalReviewHammerLatencySummary,
  resetFinalReviewHammerLatenciesForTesting } from '../src/ama-closure-orchestration.mjs';

const repo = 'fixture/project';
const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const handler = (prNumber, run) => ({ repoPath: repo, prNumber, headSha: head, run });

test('adoption readiness probes use the injected executor through the real snapshot reader', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closure-executor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, signal: options.signal });
    return { stdout: JSON.stringify({ headRefOid: head, state: 'OPEN',
      statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }) };
  };
  let prepared;
  await runQueuedReviewAdoptionPhase({
    rootDir, execFileImpl, logger: quiet,
    postedReviewHandlers: [handler(1, async () => {})],
    drainReviewerDispatchCandidates: async () => ({}),
    noProgressLaneGate: { evaluate: () => ({ run: true }) },
    recoveryRoots: new Set([rootDir]),
    preparePostedReviewHandlersImpl: (handlers, options) => preparePostedReviewHandlers(handlers, {
      ...options,
      readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: head }),
      resolveSettled: () => ({ verdict: 'comment-only', remediationPending: false }),
    }),
    runPostedReviewHandlersFairlyImpl: async ({ handlers }) => { prepared = handlers; return {}; },
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
    syncPRLifecycleImpl: async () => {},
    retryPendingCloserCancelsImpl: async () => {},
    sweepRereviewWakeQueueImpl: () => ({ scanned: 0 }),
    rereviewWakeBacklogImpl: () => ({ pending: 0 }),
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0 }),
    retryPendingDagAutowalkOnMergeImpl: async () => {},
    retryPendingMergeCloseoutsImpl: async () => {},
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0 }),
    reportStalledRetriggerOutcomesImpl: async () => ({ checked: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0 }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args.slice(0, 5), ['pr', 'view', '1', '--repo', repo]);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(prepared[0].mergeReady, true);
});

test('25 PRs: three settled same-head green reviews lead the first tick and reuse their candidates', async () => {
  let clock = 0;
  let reads = 0;
  const started = [];
  const ready = new Set([23, 24, 25]);
  const handlers = Array.from({ length: 25 }, (_, i) => handler(i + 1, async (options) => {
    started.push(i + 1);
    if (ready.has(i + 1)) assert.equal(options.preparedCandidate.value.headRefOid, head);
    clock += 25;
  }));
  const prepared = await preparePostedReviewHandlers(handlers, {
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: head }),
    resolveSettled: (_, { prNumber }) => ({ verdict: 'comment-only', remediationPending: !ready.has(prNumber) }),
    fetchSnapshot: async () => { reads++; return { headRefOid: head, state: 'OPEN', statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }; },
    now: () => 0, logger: quiet,
  });
  const state = createPostedReviewFairnessState();
  const first = await runPostedReviewHandlersFairly({ handlers: prepared, state,
    budgetMs: 100, minimumHandlerStartBudgetMs: 1, nowMs: () => clock, logger: quiet });
  assert.deepEqual(started.slice(0, 3), [23, 24, 25]);
  assert.equal(first.mergeReadyHandled, 3);
  assert.equal(reads, 3);
  assert.equal(first.ran, POSTED_REVIEW_CONCURRENCY);
  assert.equal(first.deferred.length, 21);
  const expectedFront = [...state.deferredKeys].slice(0, POSTED_REVIEW_CONCURRENCY);
  started.length = 0;
  clock = 0;
  await runPostedReviewHandlersFairly({ handlers: prepared, state,
    budgetMs: 100, minimumHandlerStartBudgetMs: 1, nowMs: () => clock, logger: quiet });
  assert.deepEqual(started.slice(0, POSTED_REVIEW_CONCURRENCY).map(n => `${repo}#${n}`), expectedFront);
});

test('priority probes leave stale heads, pending remediation, red CI and failed reads in ordinary order', async () => {
  const prepared = await preparePostedReviewHandlers(Array.from({ length: 5 }, (_, i) => handler(i + 1, async () => {})), {
    readReviewRow: h => ({ review_status: 'posted', reviewer_head_sha: h.prNumber === 1 ? otherHead : head }),
    resolveSettled: (_, { prNumber }) => ({ verdict: 'approved', remediationPending: prNumber === 2 }),
    fetchSnapshot: async (_, n) => {
      if (n === 3) throw new Error('synthetic unavailable');
      return { headRefOid: head, state: 'OPEN', statusCheckRollup: [{ name: 'build', conclusion: n === 4 ? 'FAILURE' : 'SUCCESS' }] };
    }, logger: quiet,
  });
  assert.deepEqual(prepared.map(h => Boolean(h.mergeReady)), [false, false, false, false, true]);
});

test('handlers fill exactly the fixed concurrency and refill a released slot', async () => {
  const gates = Array.from({ length: 9 }, deferred);
  let active = 0, peak = 0;
  const started = [];
  const run = runPostedReviewHandlersFairly({ handlers: gates.map((gate, i) => handler(i + 1, async () => {
    active++; peak = Math.max(peak, active); started.push(i);
    await gate.promise; active--;
  })), logger: quiet });
  try {
    await turn();
    assert.equal(started.length, POSTED_REVIEW_CONCURRENCY);
    gates[1].resolve();
    await turn();
    assert.equal(started.length, POSTED_REVIEW_CONCURRENCY + 1);
  } finally {
    gates.forEach(gate => gate.resolve());
    await run;
  }
  assert.equal(peak, POSTED_REVIEW_CONCURRENCY);
});

test('settled changes-requested reviews stay behind clean reviews without readiness probes', async () => {
  const probes = [];
  const started = [];
  const verdicts = ['request-changes', 'approved', 'comment-only'];
  const prepared = await preparePostedReviewHandlers(verdicts.map((_, i) => handler(i + 1, async () => started.push(i + 1))), {
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: head }),
    resolveSettled: (_, { prNumber }) => ({ verdict: verdicts[prNumber - 1], remediationPending: false }),
    fetchSnapshot: async (_, n) => {
      probes.push(n);
      return { headRefOid: head, state: 'OPEN', statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] };
    }, logger: quiet,
  });
  assert.deepEqual(probes, [2, 3]);
  const summary = await runPostedReviewHandlersFairly({ handlers: prepared, logger: quiet });
  assert.deepEqual(started, [2, 3, 1]);
  assert.equal(summary.mergeReadyHandled, 2);
});

test('timed-out work retains its slots across ticks until the actual work settles', async () => {
  const state = createPostedReviewFairnessState();
  const gate = deferred();
  let starts = 0;
  const handlers = Array.from({ length: 8 }, (_, i) => handler(i + 1, async () => { starts++; await gate.promise; }));
  try {
    const first = await runPostedReviewHandlersFairly({ handlers, state, handlerTimeoutMs: 10,
      minimumHandlerStartBudgetMs: 1, logger: quiet });
    assert.equal(first.timedOut, POSTED_REVIEW_CONCURRENCY);
    assert.equal(first.deferredByInFlight, 4);
    assert.equal(first.deferredByBudget, 0);
    assert.equal(starts, POSTED_REVIEW_CONCURRENCY);
    const logs = [];
    const second = await runPostedReviewHandlersFairly({ handlers, state, handlerTimeoutMs: 10,
      minimumHandlerStartBudgetMs: 1, logger: { ...quiet, log: message => logs.push(message) } });
    assert.equal(second.deferredByInFlight, 8);
    assert.equal(second.deferredByBudget, 0);
    assert.ok(logs.some(message => message.includes('budget_deferred=0 in_flight_deferred=8')));
    assert.equal(starts, POSTED_REVIEW_CONCURRENCY);
  } finally { gate.resolve(); await turn(); }
  assert.equal(state.inFlight.size, 0);
});

test('concurrent posted handlers still refuse a held per-PR lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closure-lease-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  assert.equal(acquireAmaCloserLease(identity).acquired, true);
  const outcomes = [];
  await runPostedReviewHandlersFairly({ handlers: Array.from({ length: 4 }, (_, i) => handler(i + 1, async () => {
    outcomes.push(acquireAmaCloserLease(identity).acquired);
  })), logger: quiet });
  assert.deepEqual(outcomes, [false, false, false, false]);
});

test('same-tick primary-change readers share immutable evidence while mutable PR/review/base reads stay live', async () => {
  const reads = new Map();
  const exec = async ({ args }) => {
    const path = args[1];
    reads.set(path, (reads.get(path) || 0) + 1);
    return { stdout: JSON.stringify(path.includes('/commits/') ? { sha: path.split('/').at(-1).split('?')[0], files: [], parents: [] } : { head: { sha: head } }) };
  };
  const options = { execGhWithRetryImpl: exec };
  const commit = `repos/${repo}/commits/${head}`;
  const moved = `repos/${repo}/commits/${otherHead}`;
  const pr = `repos/${repo}/pulls/1`;
  const reviews = `${pr}/reviews?per_page=100`;
  await withClosureEvaluationReadCache(async () => {
    const first = createHistoryReader(options), second = createHistoryReader(options);
    await Promise.all([first(commit), second(commit)]);
    await second(moved);
    await first(pr); await second(pr);
    await first(reviews); await second(reviews);
    assert.equal(reads.get(`${commit}?per_page=100&page=1`), 1);
    assert.equal(reads.get(pr), 2);
    assert.equal(reads.get(reviews), 2);
  });
  await withClosureEvaluationReadCache(() => createHistoryReader(options)(commit));
  assert.equal(reads.get(`${commit}?per_page=100&page=1`), 2);
  assert.equal(reads.get(`${moved}?per_page=100&page=1`), 1);
});

test('unsupported read transport falls back once per tick, retries next tick and leaves transient failures retryable', async () => {
  let calls = 0;
  const warnings = [];
  const options = { env: { GHA_ADAPTER_BIN: '/fixture/adapter' }, execFileImpl: async () => {
    calls++;
    throw Object.assign(new Error(''), { code: 78,
      stdout: JSON.stringify({ ok: false, failureClass: 'unsupported', code: 'unsupported_command', requested: 'read' }) });
  } };
  const tick = () => withGitHubAdapterReadTick(async () => {
    await assert.rejects(readAdapterPrRollup(repo, 1, options));
    assert.equal(await readAdapterHeadAndState(repo, 2, options), null);
  }, { logger: { warn: message => warnings.push(message) } });
  await tick(); await tick();
  assert.equal(calls, 2);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /rest of the tick/);
  options.execFileImpl = async () => { calls++; throw Object.assign(new Error('synthetic transient'), { code: 1 }); };
  await withGitHubAdapterReadTick(async () => {
    await assert.rejects(readAdapterPrRollup(repo, 1, options));
    await assert.rejects(readAdapterPrRollup(repo, 1, options));
  });
  assert.equal(calls, 4);
});

test('nested adapter scopes share capability refusals until the outer tick exits', async () => {
  let calls = 0;
  const warnings = [];
  const options = { env: { GHA_ADAPTER_BIN: '/fixture/nested-adapter' }, execFileImpl: async () => {
    calls++;
    throw Object.assign(new Error(''), { code: 78,
      stdout: JSON.stringify({ ok: false, failureClass: 'unsupported', code: 'unsupported_command', requested: 'read' }) });
  } };
  const logger = { warn: message => warnings.push(message) };
  await withGitHubAdapterReadTick(async () => {
    await withGitHubAdapterReadTick(async () => {
      await assert.rejects(readAdapterPrRollup(repo, 1, options));
    });
    assert.equal(await readAdapterHeadAndState(repo, 2, options), null);
    await assert.rejects(withGitHubAdapterReadTick(async () => {
      assert.equal(await readAdapterPrRollup(repo, 1, options), null);
      throw new Error('nested failure');
    }), /nested failure/);
    assert.equal(await readAdapterHeadAndState(repo, 2, options), null);
  }, { logger });
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  await withGitHubAdapterReadTick(async () => {
    await assert.rejects(readAdapterPrRollup(repo, 1, options));
  }, { logger });
  assert.equal(calls, 2, 'a new tick retries the transport');
});

test('launch latency percentiles count confirmed samples, expire after a day, and report an empty window', t => {
  resetFinalReviewHammerLatenciesForTesting();
  t.after(resetFinalReviewHammerLatenciesForTesting);
  const now = Date.now();
  assert.equal(finalReviewHammerLatencySummary(now).samples, 0);
  for (let i = 1; i <= 20; i++) recordFinalReviewHammerLatency(i * 1000, now);
  recordFinalReviewHammerLatency(-1, now);
  assert.deepEqual(finalReviewHammerLatencySummary(now), {
    window_ms: 86400000, samples: 20, p50_ms: 10000, p95_ms: 19000,
  });
  assert.equal(finalReviewHammerLatencySummary(now + 86400001).samples, 0);
  recordFinalReviewHammerLatency(1000, now);
  resetFinalReviewHammerLatenciesForTesting();
  assert.deepEqual(finalReviewHammerLatencySummary(now), {
    window_ms: 86400000, samples: 0, p50_ms: null, p95_ms: null,
  });
});

test('latency eviction retains boundary samples despite out-of-order timestamps and mass expiry', t => {
  resetFinalReviewHammerLatenciesForTesting();
  t.after(resetFinalReviewHammerLatenciesForTesting);
  const now = Date.now();
  recordFinalReviewHammerLatency(1000, now - 86400000);
  for (let i = 0; i < 9998; i++) recordFinalReviewHammerLatency(9000, now - 86400001);
  recordFinalReviewHammerLatency(2000, now);
  assert.deepEqual(finalReviewHammerLatencySummary(now), {
    window_ms: 86400000, samples: 2, p50_ms: 1000, p95_ms: 2000,
  });
  assert.deepEqual(finalReviewHammerLatencySummary(now + 1), {
    window_ms: 86400000, samples: 1, p50_ms: 2000, p95_ms: 2000,
  });
});


test('handler reuses only a recent prepared candidate for its exact head', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'prepared-closure-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const row = { review_status: 'posted', reviewer_head_sha: head };
  for (const [preparedHead, age, expectedReused] of [[head, 0, true], [head, 20_000, false], [head, -20_000, false], [otherHead, 0, false]]) {
    let reads = 0;
    await handlePostedReviewRow({ rootDir, repoPath: repo, prNumber: 1, existing: row,
      currentRevisionRef: head, currentReviewRowReader: () => row,
      preparedCandidate: { repoPath: repo, prNumber: 1, fetchedAt: Date.now() - age, value: { headRefOid: preparedHead, prState: 'open' } },
      projectGateStatusSafe: async () => null,
      fetchMergeAgentCandidateImpl: async (_, __, options) => {
        reads++; assert.equal(Boolean(options.preparedSnapshot), expectedReused);
        return { headSha: head, prState: 'open' };
      },
      buildMergeAgentDispatchJobImpl: () => ({}),
      resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome: 'ama-pending',
        amaClosureResult: { reason: 'synthetic-wait' } }),
      latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
      reviewBodyHasScopeViolationFindingImpl: () => false, logger: quiet,
    });
    assert.equal(reads, 1);
  }
});

test('immutable cache retries failed JSON and isolates credentials, executors and abortable reads', async () => {
  let calls = 0;
  let malformed = true;
  const exec = async () => { calls++; return { stdout: malformed ? 'invalid JSON' : JSON.stringify({ files: [], parents: [] }) }; };
  const path = `repos/${repo}/commits/${head}`;
  await withClosureEvaluationReadCache(async () => {
    await assert.rejects(createHistoryReader({ execGhWithRetryImpl: exec })(path));
    malformed = false;
    await createHistoryReader({ execGhWithRetryImpl: exec })(path);
    await createHistoryReader({ execGhWithRetryImpl: exec })(path);
    assert.equal(calls, 2);
    await createHistoryReader({ execGhWithRetryImpl: exec, env: { GH_TOKEN: 'synthetic-other-token' } })(path);
    assert.equal(calls, 3);
    const signal = new AbortController().signal;
    await createHistoryReader({ execGhWithRetryImpl: exec, signal })(path);
    await createHistoryReader({ execGhWithRetryImpl: exec, signal })(path);
    assert.equal(calls, 5);
    await createHistoryReader({ execGhWithRetryImpl: async () => { calls++; return { stdout: '{"files":[],"parents":[]}' }; } })(path);
    assert.equal(calls, 6);
  });
});

test('merge readiness never bypasses lane backoff or retry holds', async () => {
  const ran = [];
  const result = await runPostedReviewHandlersFairly({
    handlers: [1, 2].map(n => ({ ...handler(n, async () => ran.push(n)), mergeReady: true })),
    laneGate: { evaluate: h => ({ run: false, retryAfterMs: h.prNumber === 2 ? 100 : 0 }) },
    laneStarvationFloor: 0,
    logger: quiet,
  });
  assert.deepEqual(ran, []);
  assert.equal(result.skippedByLane, 2);
  assert.equal(result.priorityLaneBypasses, 0);
});

for (const reason of ['worker-identity-unresolved', 'operator-hold', 'autonomous-merge-disabled']) {
  test(`green settled PR parked on ${reason} is not probed or run before lane backoff`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closure-lane-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo, prNumber: 1 };
    for (let i = 0; i < 5; i++) recordNoProgressLaneRun(rootDir, identity, {
      headSha: head, fingerprint: 'unchanged', operatorReason: reason,
      progressClass: reason === 'operator-hold' ? 'operator-decision-required' : 'self-resolving',
      logger: quiet,
    });
    const baseline = readNoProgressLane(rootDir, identity);
    const row = { review_status: 'posted', reviewer_head_sha: head };
    const laneGate = createNoProgressLaneGate({ rootDir, hqRoot: join(rootDir, 'hq'),
      readReviewRow: () => row, logger: quiet });
    const reads = [], ran = [];
    const prepare = () => preparePostedReviewHandlers([1, 2].map(n => handler(n, async () => { ran.push(n); })), {
      laneGate, readReviewRow: () => row,
      resolveSettled: () => ({ verdict: 'comment-only', remediationPending: false }),
      fetchSnapshot: async (_, n) => {
        reads.push(n);
        return { headRefOid: head, state: 'OPEN', labels: [{ name: 'operator-hold' }],
          statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] };
      }, logger: quiet,
    });
    const prepared = await prepare();
    assert.deepEqual(reads, [2]);
    assert.equal(readNoProgressLane(rootDir, identity).skippedTicks, baseline.skippedTicks,
      'readiness preview must not count a skipped tick');
    const summary = await runPostedReviewHandlersFairly({ handlers: prepared, laneGate, logger: quiet });
    assert.deepEqual(ran, [2]);
    assert.equal(summary.skippedByLane, 1);
    assert.equal(summary.priorityLaneBypasses, 0);
    const skipped = readNoProgressLane(rootDir, identity);
    assert.equal(skipped.skippedTicks, baseline.skippedTicks + 1);
    assert.equal(skipped.noProgressTicks, baseline.noProgressTicks);
    assert.equal(skipped.lastRunAt, baseline.lastRunAt);

    // Ordinary cadence still makes the parked PR eligible for a fresh probe.
    while (!laneGate.evaluate(prepared[0], { recordSkip: false }).run) {
      recordNoProgressLaneSkip(rootDir, identity, { headSha: head, logger: quiet });
    }
    reads.length = 0;
    const due = await prepare();
    assert.ok(reads.includes(1));
    assert.equal(due[0].mergeReady, true);
    ran.length = 0;
    await runPostedReviewHandlersFairly({ handlers: due, laneGate, logger: quiet });
    assert.ok(ran.includes(1));
  });
}


test('unsupported-command evidence selects the real GitHub helper fallback without repeating the adapter', async () => {
  const transports = [];
  const events = [];
  const execFileImpl = async command => {
    transports.push(command);
    if (command === '/fixture/unsupported-adapter') throw Object.assign(new Error(''), {
      code: 78, stdout: JSON.stringify({ ok: false, failureClass: 'unsupported',
        code: 'unsupported_command', requested: 'read' }),
    });
    assert.equal(command, 'gh');
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
      state: 'OPEN', headRefOid: head, author: { login: 'fixture-builder' },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } }) };
  };
  await withGitHubAdapterReadTick(async () => {
    for (const prNumber of [1, 2]) {
      const result = await fetchPullRequestHeadAndState(repo, prNumber, {
        execFileImpl, env: { GHA_ADAPTER_BIN: '/fixture/unsupported-adapter' },
        recordApiCallImpl: event => events.push(event),
      });
      assert.equal(result.headRefOid, head);
      assert.equal(result.state, 'open');
    }
  }, { logger: quiet });
  assert.deepEqual(transports, ['/fixture/unsupported-adapter', 'gh', 'gh']);
  assert.equal(events.filter(event => event.status === 'exec_error').length, 1);
});

test('priority preparation stays inside its tick deadline and leaves unprobed work available', async () => {
  let clock = 0, reads = 0;
  const prepared = await preparePostedReviewHandlers([1, 2, 3, 4, 5].map(n => handler(n, async () => {})), {
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: head }),
    resolveSettled: () => ({ verdict: 'approved', remediationPending: false }),
    fetchSnapshot: async () => { reads++; clock = 100; return { headRefOid: head, state: 'OPEN', statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }; },
    now: () => clock, deadlineAt: 100, logger: quiet,
  });
  assert.equal(reads, POSTED_REVIEW_CONCURRENCY);
  assert.equal(prepared[4].mergeReady, undefined);
  let starts = 0;
  const summary = await runPostedReviewHandlersFairly({
    handlers: [handler(1, async () => { starts++; })], phaseStartedMs: 0,
    nowMs: () => clock, budgetMs: 100, minimumHandlerStartBudgetMs: 1, logger: quiet,
  });
  assert.equal(starts, 0);
  assert.equal(summary.deferredByBudget, 1);
});


test('read-only snapshot reuse saves the PR read and still runs the normal stacked-base guard', async () => {
  let reads = 0, guards = 0;
  const execFileImpl = async (command, args) => {
    reads++;
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['pr', 'view', '1']);
    return { stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', labels: [],
      statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }) };
  };
  const preparedSnapshot = await fetchMergeAgentCandidateSnapshot(repo, 1, { execFileImpl });
  assert.equal(reads, 1);
  const hold = { reason: 'synthetic-stacked-base-hold' };
  const candidate = await fetchMergeAgentCandidate(repo, 1, { execFileImpl, preparedSnapshot,
    guardStackedBaseImpl: async () => { guards++; return hold; } });
  assert.equal(reads, 1, 'candidate evaluation reuses the tick snapshot');
  assert.equal(guards, 1, 'reuse cannot bypass the existing guard');
  assert.equal(candidate.stackedBaseHold, hold);
});
