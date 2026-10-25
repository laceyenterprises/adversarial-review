import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createMergeAgentSnapshotPass, fetchMergeAgentCandidateSnapshot } from '../src/merge-agent-candidate-snapshot.mjs';
import { withPostedReviewReadCache, closePostedReviewReadCache } from '../src/posted-review-read-cache.mjs';
import { readClosureImmutable, withClosureEvaluationReadCache } from '../src/closure-evaluation-cache.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { classifyCheckRollup } from '../src/checks-summary.mjs';
import { decideClosureOwner } from './helpers/closure-owner-fixture.mjs';
import { handlePostedReviewRow } from '../src/posted-review-row.mjs';

const subjectKey = 's-01';
const head = 'a'.repeat(40), movedHead = 'b'.repeat(40);
const clock = Date.parse('2026-01-02T03:04:05Z');
const source = value => ({ sourceRef: 'e-01', read: () => value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('one immutable generation serves three consumers; subjects, passes and effects read independently', async () => {
  let reads = 0, now = clock;
  const anchors = { firstActionableAt: '2026-01-01T00:00:00Z', deadline: '2026-01-01T00:05:00Z' };
  const data = { headSha: head, labels: ['x-01'] };
  const request = { subjectKey, head, anchors, sources: { pr: { sourceRef: 'e-01', read: () => { reads++; return data; } } } };
  const pass = createMergeAgentSnapshotPass({ now: () => now });
  const [a, b, c] = await Promise.all([pass.collect(request), pass.collect(request), pass.collect(request)]);
  assert.equal(reads, 1);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(a.observedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(a.anchors, anchors);
  assert.equal(a.observations.policy.state, 'unknown');
  data.labels.push('x-02'); anchors.deadline = '2026-01-03T00:00:00Z';
  assert.deepEqual(a.observations.pr.value.labels, ['x-01']);
  assert.throws(() => a.observations.pr.value.labels.push('x-03'), TypeError);
  assert.equal(a.anchors.deadline, '2026-01-01T00:05:00Z');
  await pass.collect({ ...request, subjectKey: 's-02' });
  assert.equal(reads, 2);
  now += 60_000;
  assert.equal(await pass.collect(request), a, 'poll clock cannot slide a generation or durable deadline');
  pass.invalidate(subjectKey);
  assert.equal(pass.isCurrent(a), false);
  const afterEffect = await pass.collect(request);
  assert.ok(afterEffect.generation > a.generation);
  assert.equal(reads, 3);
  pass.close();
  assert.equal(pass.isCurrent(afterEffect), false);
  await createMergeAgentSnapshotPass({ now: () => now }).collect(request);
  assert.equal(reads, 4);
});

test('isCurrent rejects absent and unrelated snapshots throughout the pass lifetime', async () => {
  const pass = createMergeAgentSnapshotPass();
  const assertAbsent = () => {
    for (const value of [null, undefined, {}, { subjectKey }]) assert.equal(pass.isCurrent(value), false);
  };
  assertAbsent();
  const snapshot = await pass.collect({ subjectKey, head, sources: { pr: source({ headSha: head }) } });
  assertAbsent();
  assert.equal(pass.isCurrent(snapshot), true);
  assert.equal(pass.isCurrent({ ...snapshot }), false);
  pass.invalidate(subjectKey);
  assertAbsent();
  assert.equal(pass.isCurrent(snapshot), false);
  pass.close();
  assertAbsent();
});

test('head changes and invalidation during a read cannot make an old generation current', async () => {
  const pass = createMergeAgentSnapshotPass();
  const gate = deferred();
  const pending = pass.collect({ subjectKey, head, sources: { pr: { read: async () => { await gate.promise; return { headSha: head }; } } } });
  const next = await pass.collect({ subjectKey, head: movedHead, sources: { pr: source({ headSha: movedHead }) } });
  gate.resolve();
  const old = await pending;
  assert.equal(pass.isCurrent(old), false);
  assert.equal(pass.isCurrent(next), true);
  pass.invalidate(subjectKey);
  const movedWhileReading = await pass.collect({ subjectKey, head, sources: { pr: source({ headSha: movedHead }) } });
  assert.equal(movedWhileReading.head, movedHead);
  assert.equal(movedWhileReading.requestedHead, head);
  assert.equal(pass.isCurrent(movedWhileReading), false);
});

test('partial, missing, malformed and failed reads retain separate provenance without diagnostics', async () => {
  const pass = createMergeAgentSnapshotPass({ now: () => clock });
  const snapshot = await pass.collect({ subjectKey, head, sources: {
    pr: source({ headSha: head }),
    reviews: source({ state: 'unknown', value: [{ head }], provenance: { sourceRef: 'e-02', pageComplete: false } }),
    checks: { sourceRef: 'e-03', read: () => { throw Object.assign(new Error('fabricated provider detail'), { code: 'EIO' }); } },
    policy: source(() => 'executable'),
    controls: { ...source(['malformed']), validate: value => !Array.isArray(value) },
  } });
  assert.equal(snapshot.observations.pr.state, 'complete');
  assert.equal(snapshot.observations.reviews.state, 'unknown');
  assert.equal(snapshot.observations.reviews.value.length, 1);
  assert.equal(snapshot.observations.reviews.provenance.sourceRef, 'e-02');
  assert.deepEqual(snapshot.observations.checks.error, { name: 'Error', code: 'EIO' });
  assert.equal(snapshot.observations.checks.provenance.sourceRef, 'e-03');
  assert.equal(snapshot.observations.policy.state, 'error');
  assert.equal(snapshot.observations.controls.state, 'error');
  assert.equal(snapshot.observations.history.state, 'unknown');
  assert.ok(!JSON.stringify(snapshot).includes('fabricated provider detail'));
});

test('snapshot reads retain the four-read bound and settle every sibling before returning', async () => {
  const gate = deferred();
  let active = 0, peak = 0, settled = 0;
  const names = ['pr', 'checks', 'reviews', 'remediation', 'launches', 'leases', 'controls', 'policy', 'progress', 'history'];
  const sources = Object.fromEntries(names.map(name => [name, { read: async () => {
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--; settled++;
    if (name === 'reviews') throw new Error('synthetic read failure');
    return {};
  } }]));
  const pending = createMergeAgentSnapshotPass().collect({ subjectKey, head, sources });
  await turn(); assert.equal(active, 4);
  gate.resolve();
  const snapshot = await pending;
  assert.equal(peak, 4); assert.equal(settled, names.length); assert.equal(active, 0);
  assert.equal(snapshot.observations.reviews.state, 'error');
});

test('cancellation scopes cannot poison another consumer or publish the aborted generation', async () => {
  const a = new AbortController(), b = new AbortController();
  const gate = deferred();
  let calls = 0;
  const request = { subjectKey, head, sources: { pr: { read: async () => { calls++; await gate.promise; return { headSha: head }; } } } };
  const pass = createMergeAgentSnapshotPass();
  const first = pass.collect({ ...request, signal: a.signal });
  const rejected = assert.rejects(first, /synthetic cancellation/);
  const second = pass.collect({ ...request, signal: b.signal });
  a.abort(new Error('synthetic cancellation')); gate.resolve();
  await rejected;
  const snapshot = await second;
  assert.equal(calls, 2); assert.equal(pass.isCurrent(snapshot), true);
});

test('raw PR reads share one immutable value only inside the same handler/head and refresh after effects', async () => {
  let reads = 0;
  const env = { GH_TOKEN: 'synthetic-token' };
  const execFileImpl = async (_command, _args, options) => {
    assert.equal(options.env.GH_TOKEN, env.GH_TOKEN);
    reads++;
    return { stdout: JSON.stringify({ headRefOid: head, isDraft: false, state: 'OPEN', labels: [] }) };
  };
  const read = () => fetchMergeAgentCandidateSnapshot(subjectKey, 1, { execFileImpl, env });
  await withPostedReviewReadCache({ repo: subjectKey, prNumber: 1, headSha: head }, async () => {
    const [a, b] = await Promise.all([read(), read()]);
    assert.equal(a, b); assert.equal(reads, 1);
    assert.throws(() => a.labels.push('x-01'), TypeError);
    await withPostedReviewReadCache({ repo: subjectKey, prNumber: 2, headSha: head }, () => fetchMergeAgentCandidateSnapshot(subjectKey, 2, { execFileImpl, env }));
    assert.equal(reads, 2);
    closePostedReviewReadCache(); await read(); assert.equal(reads, 3);
  });
  await withPostedReviewReadCache({ repo: subjectKey, prNumber: 1, headSha: head }, read);
  assert.equal(reads, 4);
});

test('immutable history cannot be poisoned and completed evidence survives new operation signals', async () => {
  let calls = 0;
  const execGhWithRetryImpl = async () => { calls++; return { stdout: JSON.stringify({ sha: head, files: [{ filename: 'f-01' }], parents: [] }) }; };
  const path = `repos/${subjectKey}/commits/${head}`;
  await withClosureEvaluationReadCache(async () => {
    const first = await createHistoryReader({ execGhWithRetryImpl })(path);
    assert.throws(() => { first.files[0].filename = 'f-02'; }, TypeError);
    const next = await createHistoryReader({ execGhWithRetryImpl, signal: new AbortController().signal })(path);
    assert.equal(next.files[0].filename, 'f-01'); assert.equal(calls, 1);
  });
  await withClosureEvaluationReadCache(() => createHistoryReader({ execGhWithRetryImpl })(path));
  assert.equal(calls, 2);
});

test('uncached closure reads copy and freeze evidence with or without an asynchronous reader', async () => {
  for (const asynchronous of [false, true]) {
    const original = { files: [{ filename: 'f-01' }] };
    const run = () => asynchronous ? Promise.resolve(original) : original;
    const snapshot = await readClosureImmutable(run, ['uncached'], run);
    original.files[0].filename = 'f-02';
    assert.equal(snapshot.files[0].filename, 'f-01');
    assert.throws(() => { snapshot.files[0].filename = 'f-03'; }, TypeError);
    assert.throws(() => snapshot.files.push({}), TypeError);
    assert.ok(Object.isFrozen(snapshot));
    assert.notEqual(await readClosureImmutable(run, ['uncached'], run), snapshot);
  }
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(readClosureImmutable(null, [], () => cyclic), /plain acyclic value/);
});

test('reads from an expired closure scope still return immutable evidence', async () => {
  const gate = deferred();
  let lateRead;
  await withClosureEvaluationReadCache(() => {
    lateRead = gate.promise.then(() => readClosureImmutable(null, [], () => ({ nested: [] })));
  });
  gate.resolve();
  const snapshot = await lateRead;
  assert.throws(() => snapshot.nested.push('mutation'), TypeError);
});

test('a failed tree read is retried by the same history reader within its original budget', async () => {
  let failedTreeReads = 0;
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
    const path = args[1];
    if (path.includes('/compare/')) return { stdout: JSON.stringify({ status: 'ahead', total_commits: 0, commits: [], merge_base_commit: { sha: head } }) };
    if (path.endsWith(`/trees/${head}`) && ++failedTreeReads === 1) throw new Error('synthetic tree failure');
    return { stdout: JSON.stringify({ tree: [], truncated: false }) };
  } });
  const path = `repos/${subjectKey}/s-02/compare/${head}...${movedHead}`;
  await assert.rejects(get(path), /synthetic tree failure/);
  const evidence = await get(path);
  assert.equal(evidence.filesComplete, true);
  assert.deepEqual(evidence.files, []);
  assert.equal(failedTreeReads, 2);
});

test('raw PR cache retries transient executor failures with default and identical signals', async () => {
  for (const signal of [undefined, new AbortController().signal]) {
    let calls = 0;
    const options = { signal, env: {}, execFileImpl: async () => {
      if (++calls === 1) throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      return { stdout: JSON.stringify({ headRefOid: head }) };
    } };
    await withPostedReviewReadCache({ repo: subjectKey, prNumber: 1, headSha: head }, async () => {
      await assert.rejects(fetchMergeAgentCandidateSnapshot(subjectKey, 1, options), { code: 'ETIMEDOUT' });
      const value = await fetchMergeAgentCandidateSnapshot(subjectKey, 1, options);
      assert.equal(await fetchMergeAgentCandidateSnapshot(subjectKey, 1, options), value);
      assert.equal(calls, 2);
    });
  }
});

test('raw PR cache retries malformed JSON and binds an initially unknown head once', async () => {
  let calls = 0;
  const options = { env: {}, execFileImpl: async () => ({ stdout: ++calls === 1 ? '{' : JSON.stringify({ headRefOid: head }) }) };
  await withPostedReviewReadCache({ repo: subjectKey, prNumber: 1 }, async () => {
    await assert.rejects(fetchMergeAgentCandidateSnapshot(subjectKey, 1, options), SyntaxError);
    const value = await fetchMergeAgentCandidateSnapshot(subjectKey, 1, options);
    assert.equal(await fetchMergeAgentCandidateSnapshot(subjectKey, 1, options), value);
    assert.equal(calls, 2);
  });
});

test('raw PR cancellation cannot discard another signal result or move its observed head', async () => {
  const a = new AbortController(), b = new AbortController(), gate = deferred();
  let calls = 0;
  const execFileImpl = async () => { const index = ++calls; await gate.promise;
    return { stdout: JSON.stringify({ headRefOid: index === 1 ? head : movedHead }) }; };
  await withPostedReviewReadCache({ repo: subjectKey, prNumber: 1, headSha: head }, async () => {
    const first = fetchMergeAgentCandidateSnapshot(subjectKey, 1, { execFileImpl, signal: a.signal, env: {} });
    const rejected = assert.rejects(first, /synthetic cancellation/);
    const second = fetchMergeAgentCandidateSnapshot(subjectKey, 1, { execFileImpl, signal: b.signal, env: {} });
    await turn(); a.abort(new Error('synthetic cancellation')); gate.resolve();
    await rejected;
    const value = await second;
    assert.equal(value.headRefOid, movedHead);
    assert.equal(await fetchMergeAgentCandidateSnapshot(subjectKey, 1, { execFileImpl, env: {} }), value);
    assert.equal(calls, 2);
  });
});

test('a malformed launch status is unknown and a remote merged receipt remains separate evidence', async () => {
  const snapshot = await createMergeAgentSnapshotPass().collect({ subjectKey, head, sources: {
    pr: source({ headSha: head, state: 'merged', mergedAt: '2026-01-01T00:00:00Z' }),
    launches: { read: () => readLaunchRequestObservationFromLedgerAsync({ launchRequestId: 'l-01',
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'malformed' }, retryChain: [] }),
      readWorkerStatusImpl: async () => assert.fail('malformed launch cannot prove running worker'),
    }) },
  } });
  assert.equal(snapshot.observations.launches.state, 'unknown');
  assert.equal(snapshot.observations.launches.value.inFlight, null);
  assert.equal(snapshot.observations.launches.value.remoteMerge, null);
  assert.equal(snapshot.observations.pr.value.state, 'merged');
});

test('PR unknown state remains PR data and non-plain evidence is recorded as malformed', async () => {
  let getterCalls = 0;
  const malformed = { get state() { getterCalls++; return 'complete'; } };
  const snapshot = await createMergeAgentSnapshotPass().collect({ subjectKey, head, sources: {
    pr: source({ headSha: head, state: 'unknown' }), policy: source(malformed),
  } });
  assert.equal(snapshot.observations.pr.value.state, 'unknown');
  assert.equal(snapshot.observations.policy.state, 'error');
  assert.equal(getterCalls, 0);
});

test('a first observation without a readable head remains collectable and explicit', async () => {
  const snapshot = await createMergeAgentSnapshotPass().collect({ subjectKey,
    sources: { pr: source({ state: 'unknown' }) } });
  assert.equal(snapshot.head, null);
  assert.equal(snapshot.observations.pr.value.state, 'unknown');
});

test('a missing retry projection never establishes absence of descendants', async () => {
  const observation = await readLaunchRequestObservationFromLedgerAsync({ launchRequestId: 'l-01',
    readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'succeeded' } }),
    readWorkerStatusImpl: async () => assert.fail('terminal launch cannot require worker projection'),
  });
  assert.equal(observation.state, 'unknown');
  assert.equal(observation.value.inFlight, null);
  assert.equal(observation.value.terminal, false);
});

for (const [status, expected] of [['IN_PROGRESS', 'PENDING'], ['FAILURE', 'FAILURE'], ['SUCCESS', 'SUCCESS']]) {
  test(`checks preserve ${status}, including runner-less failures, for the shared classifier`, async () => {
    const rollup = [{ name: 'c-01', ...(status === 'IN_PROGRESS' ? { status } : { status: 'COMPLETED', conclusion: status }), startedAt: null }];
    const snapshot = await createMergeAgentSnapshotPass().collect({ subjectKey, head,
      sources: { checks: source({ rollup, requiredContexts: ['c-01'] }) } });
    const checks = snapshot.observations.checks.value;
    assert.deepEqual(checks.rollup, rollup);
    assert.equal(classifyCheckRollup(checks.rollup, checks), expected);
  });
}

for (const kind of ['terminal', 'live-retry', 'unreadable-retry']) {
  test(`${kind} launch is observed once without touching a foreign lease or treating exit zero as merged`, async () => {
    let reads = 0, workerReads = 0;
    const foreignLease = { lrqId: 'l-02', status: 'dispatched' };
    const probe = { ok: true, row: { launch_request_id: 'l-01', status: 'succeeded' },
      retryChain: kind === 'live-retry' ? [{ launch_request_id: 'l-03', status: 'running' }] : [],
      ...(kind === 'unreadable-retry' ? { retryChainUnreadable: true } : {}) };
    const pass = createMergeAgentSnapshotPass();
    const request = { subjectKey, head, sources: {
      leases: source(foreignLease),
      launches: { read: () => readLaunchRequestObservationFromLedgerAsync({ launchRequestId: 'l-01',
        readLaunchRequestStatusImpl: async args => { reads++; assert.equal(args.includeRetryChain, true); return probe; },
        readWorkerStatusImpl: async args => { workerReads++; assert.equal(args.launchRequestId, 'l-03'); return { ok: true, row: { status: 'running' } }; },
      }) },
    } };
    const [a, b] = await Promise.all([pass.collect(request), pass.collect(request)]);
    assert.equal(a, b); assert.equal(reads, 1);
    const observation = a.observations.launches;
    const launch = observation.value;
    assert.equal(launch.remoteMerge, null);
    assert.deepEqual(foreignLease, { lrqId: 'l-02', status: 'dispatched' });
    assert.equal(workerReads, kind === 'live-retry' ? 1 : 0, 'terminal launch outranks stale active worker');
    assert.equal(launch.inFlight, kind === 'terminal' ? false : kind === 'live-retry' ? true : null);
    assert.equal(launch.terminal, kind === 'terminal');
    assert.equal(observation.state, kind === 'unreadable-retry' ? 'unknown' : 'complete');
  });
}

test('active launch worker reads prefer the resolved row ID over absent or unresolved caller IDs', async () => {
  for (const status of ['starting', 'running']) {
    for (const launchRequestId of [undefined, '', 'unresolved-alias']) {
      let workerReads = 0;
      const observation = await readLaunchRequestObservationFromLedgerAsync({ launchRequestId,
        readLaunchRequestStatusImpl: async () => ({ ok: true,
          row: { launch_request_id: 'l-resolved', status }, retryChain: [] }),
        readWorkerStatusImpl: async args => {
          workerReads++;
          assert.equal(args.launchRequestId, 'l-resolved');
          return { ok: true, row: { status: 'running' } };
        },
      });
      assert.equal(workerReads, 1);
      assert.equal(observation.state, 'complete');
      assert.equal(observation.value.worker.status, 'running');
    }
  }
});

test('shared owner evidence remains identical after immutable collection', async () => {
  const clean = { reviewState: { verdict: 'approved', headSha: head,
    blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 }, currentHead: head };
  for (const [input, owner] of [[clean, 'daemon-merge'], [{ ...clean, checks: 'PENDING' }, 'wait'],
    [{ ...clean, checks: 'FAILURE' }, 'hammer'],
    [{ ...clean, checks: 'FAILURE', followUpJob: { status: 'pending', revisionRef: movedHead } }, 'remediation'],
    [{ ...clean, mergeable: 'CONFLICTING' }, 'hammer'],
    [{ ...clean, reviewState: {} }, 'review'], [{ ...clean, reviewState: { verdict: 'request-changes', headSha: head } }, 'remediation']]) {
    const before = decideClosureOwner(input);
    const snapshot = await createMergeAgentSnapshotPass().collect({ subjectKey, head, sources: { candidate: source(input) } });
    assert.deepEqual(decideClosureOwner(snapshot.observations.candidate.value), before);
    assert.equal(before.owner, owner);
  }
});

for (const postedAt of ['2026-01-01T00:00:00Z', undefined]) {
  test(`posted handler shares its snapshot and preserves wait with posted anchor ${postedAt}`, async () => {
    let builtSnapshot, closureSnapshot;
    const row = { review_status: 'posted', reviewer_head_sha: head, posted_at: postedAt };
    const result = await handlePostedReviewRow({ repoPath: 'owner/repo', prNumber: 1, currentRevisionRef: head,
      now: () => clock, currentReviewRowReader: () => row, projectGateStatusSafe: async () => null,
      latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
      fetchMergeAgentCandidateImpl: async () => ({ headSha: head, prState: 'open' }),
      buildMergeAgentDispatchJobImpl: (_root, _candidate, { passSnapshot }) => { builtSnapshot = passSnapshot; return {}; },
      resolveMergeAgentCoexistenceForWatcherImpl: async ({ passSnapshot }) => {
        closureSnapshot = passSnapshot;
        return { outcome: 'ama-pending', amaClosureResult: { reason: 'synthetic-wait' } };
      }, logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal(builtSnapshot, closureSnapshot);
    assert.equal(builtSnapshot.anchors.postedAt, postedAt ?? null);
    assert.equal(builtSnapshot.anchors.reviewerStartedAt, null);
    assert.equal(builtSnapshot.observations.launches.state, 'unknown');
    assert.equal(result.outcome, 'ama-pending');
    assert.deepEqual(result, { handled: true, outcome: 'ama-pending', urgent: false, gateDecision: null });
  });
}
