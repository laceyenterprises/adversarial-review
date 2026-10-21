import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool, runWithAgyReviewerIdentity } from '../src/agy-reviewer-identities.mjs';
import { resolveGeminiCredentialConcurrencyForDispatchCandidates } from '../src/reviewer-runtime-support.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';
import { readIdentityPoolProjection } from '../src/identity-token-snapshot.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { createAgyHolderLeaseStore } from '../src/agy-holder-leases.mjs';

const owner = 'fixture-owner';
const users = ['fixture-login-a', 'fixture-login-b'];
const adapter = { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) };
const log = { log() {}, warn() {}, error() {}, info() {} };
const declarations = (holders = users) => ({
  token_accounts: Object.fromEntries(holders.map((user, i) => [`agy-login-${i}`, {
    family: 'gemini', holder_user: user, concurrency: 1, allowed_models: ['gemini-test'],
  }])),
  identity_token_pools: { 'gemini-reviewer': holders.map((_, i) => `agy-login-${i}`) },
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'itp11-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function pool(root, options = {}) {
  return createAgyReviewerIdentityPool({
    env: { ADVERSARIAL_REVIEW_STATE_DIR: join(root, 'data') },
    log, hqOwner: owner, runStateRootDir: root, leaseWaitMs: 0,
    resolveRuntime: () => 'antigravity', resolveModel: () => 'gemini-test', loadIdentities: () => users,
    loadTokenPools: () => declarations(),
    referenceSettings: () => [], readBootstrapRecordImpl: () => null,
    checkHqOwnerAuthImpl: async () => ({ ok: true }),
    readQuotaCooldownImpl: () => null, readActiveRunRecordsImpl: () => [],
    verifyPgidIdentityImpl: async () => ({ match: true }),
    listUserProcessesImpl: async () => ({ ok: true, processes: [] }),
    runPinnedImpl: async ({ args }) => ({ code: 0, stdout: args[0] === 'status'
      ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n'
      : args[0] === 'probe' ? 'probe.ok=yes\n' : '' }),
    deliverAlertImpl: async () => { throw new Error('fixture must never alert'); },
    ...options,
  });
}

for (const ready of [2, 1]) test(`ITP-11: ${ready} ready holder(s) dispatch ${ready} canonical reviews and hold queued work`, async t => {
    const root = fixture(t);
    const p = pool(root, { readQuotaCooldownImpl: user => ready === 1 && user === users[1] ? { resetAt: 'future' } : null });
    const candidates = [1, 2, 3].map(prNumber => ({ reviewerModel: 'gemini', prNumber,
      reviewerRuntimeAdapter: adapter, run: async () => new Promise(() => {}) }));
    const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates(candidates, {
      identityPool: p, logger: log, fetchCredentialConcurrency: async () => { throw new Error('no broker'); },
    });
    assert.equal(cap, ready);
    const leases = [];
    const completions = [];
    for (const candidate of candidates) candidate.run = () => runWithAgyReviewerIdentity({
      reviewerModel: 'gemini', adapter, pool: p, log,
    }, async (_runtimeHolder, lease) => {
      leases.push(lease);
      await new Promise(resolve => completions.push(resolve));
      return { ok: true };
    });
    const runs = [];
    const result = await runBoundedReviewerDispatchQueue(candidates, {
      maxConcurrent: 3, geminiCredentialConcurrency: cap, singleWave: true,
      singleWaveSettleGraceMs: 20, logger: log, onCandidateStarted: run => runs.push(run.promise),
    });
    try {
      assert.equal(result.maxObservedConcurrency, ready);
      assert.equal(result.deferred, 3 - ready);
      assert.equal(leases.length, ready);
      assert.equal(new Set(leases.map(lease => lease.user)).size, ready);
      assert.ok(leases.every(lease => lease.identity === 'gemini-reviewer' && lease.tokenAccountId && lease.generation));
      assert.equal(p.projection().capacity, ready);
      assert.equal(p.projection().active, ready);
      assert.equal(p.projection().free, 0);
      assert.ok(readIdentityPoolProjection({ 'gemini-reviewer': p.projection() }, declarations()));
    } finally {
      completions.forEach(resolve => resolve());
      await Promise.all(runs);
    }
});

test('ITP-11: independent watcher contention never leases the same holder twice (25 trials)', async t => {
  const root = fixture(t);
  let overbooked = 0;
  for (let trial = 0; trial < 25; trial++) {
    const options = { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]) };
    const a = pool(root, options), b = pool(root, options);
    const leases = await Promise.all([a.acquire({ reviewId: `a-${trial}` }), b.acquire({ reviewId: `b-${trial}` })]);
    if (leases.filter(Boolean).length !== 1) overbooked++;
    await Promise.all([a.release(leases[0]), b.release(leases[1])]);
  }
  assert.equal(overbooked, 0, `overbooked ${overbooked}/25 trials`);
});

test('ITP-11: duplicate holder aliases fail closed; locked and capped holders isolate their sibling', async t => {
  const root = fixture(t);
  const duplicate = pool(root, { loadTokenPools: () => declarations([users[0], users[0]]) });
  assert.equal(await duplicate.acquire(), null, 'invalid declaration must never fall back to owner');
  for (const condition of ['locked', 'capped']) {
    const p = pool(root, {
      readQuotaCooldownImpl: user => condition === 'capped' && user === users[0] ? {} : null,
      runPinnedImpl: async ({ user, args }) => ({ code: 0, stdout: args[0] === 'status'
        ? `keychain.exists=yes\nkeychain.item=${condition === 'locked' && user === users[0] ? 'locked' : 'readable'}\nsettings.valid=yes\n` : '' }),
    });
    const lease = await p.acquire();
    assert.equal(lease?.user, users[1]);
    assert.equal(lease.identity, 'gemini-reviewer');
    await p.release(lease);
  }
});

test('ITP-11: canonical run receipt adopts a surviving holder despite stale heartbeat', async t => {
  const root = fixture(t);
  const record = { pgid: 4242, sessionUuid: 'survivor', state: 'heartbeating', lastHeartbeatAt: '2000-01-01T00:00:00Z',
    subjectContext: { agyHolderLease: { identity: 'gemini-reviewer', tokenAccountId: 'agy-login-0',
      user: users[0], reviewId: 'old-review', generation: 'old-generation' } } };
  const p = pool(root, { readActiveRunRecordsImpl: () => [record], isPgidAliveImpl: () => true });
  const lease = await p.acquire();
  assert.equal(lease?.user, users[1]);
  assert.deepEqual(p.snapshot().find(row => row.user === users[0]).adoptedReviews, ['old-review']);
  await p.release(lease);
});

test('ITP-11: failed OAuth probes back off durably instead of hot-looping after restart', async t => {
  const root = fixture(t);
  let probes = 0;
  const options = { now: () => 1000,
    loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]),
    runPinnedImpl: async ({ args }) => {
      if (args[0] === 'probe') { probes++; return { code: 1, stdout: 'probe.ok=no\n' }; }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    },
  };
  let p = pool(root, options);
  const lease = await p.acquire();
  await p.release(lease, { failed: true, reason: 'oauth' });
  for (let i = 0; i < 6; i++) {
    await p.refreshReadiness();
    await p.settleProbes();
    if (i === 2) p = pool(root, options);
  }
  assert.equal(probes, 1, 'one failed probe in the cooldown window across restart');
  assert.equal(await p.acquire(), null);
});

test('ITP-11: explicit owner singleton is leased once and stale generations cannot release it', async t => {
  const root = fixture(t);
  const p = pool(root, { loadIdentities: () => [], loadTokenPools: () => declarations([owner]) });
  const lease = await p.acquire({ reviewId: 'owner-first' });
  assert.equal(lease?.identity, 'gemini-reviewer');
  assert.equal(await p.acquire({ reviewId: 'owner-first' }), lease, 'same request is idempotent');
  assert.equal(await p.acquire({ reviewId: 'owner-second' }), null);
  await p.release({ ...lease, generation: 'stale-generation' });
  assert.equal(await p.acquire({ reviewId: 'owner-third' }), null);
  await p.release(lease);
  const next = await p.acquire({ reviewId: 'owner-next' });
  assert.ok(next);
  assert.notEqual(next.generation, lease.generation);
  await p.release(next);
});

test('ITP-11: dead watcher claims require live run and survivor evidence before reuse', async t => {
  const root = fixture(t);
  const first = pool(root);
  const lease = await first.acquire({ reviewId: 'before-restart' });
  let alive = true;
  const restarted = pool(root, {
    isLeaseOwnerAliveImpl: () => false,
    listUserProcessesImpl: async ({ user }) => ({ ok: true, processes: alive && user === users[0]
      ? [{ pid: 4242, pgid: 4242, comm: 'agy' }] : [] }),
  });
  const sibling = await restarted.acquire({ reviewId: 'sibling' });
  assert.equal(sibling.user, users[1]);
  await restarted.release(sibling);
  alive = false;
  await restarted.refreshReadiness();
  const replacement = await restarted.acquire({ reviewId: 'after-exit' });
  assert.equal(replacement.user, users[0]);
  await first.release(lease); // Stale generation cannot clear the replacement.
  const row = JSON.parse(readFileSync(join(root, 'data', 'agy-holder-leases', `${users[0]}.json`)));
  assert.equal(row.lease.generation, replacement.generation);
  await restarted.release(replacement);
});

test('ITP-11: generation changes during readiness hold dispatch, and account model denial cannot widen eligibility', async t => {
  const root = fixture(t);
  let model = 'gemini-test';
  let changed = false;
  const p = pool(root, { resolveModel: () => model,
    runPinnedImpl: async ({ args }) => {
      if (!changed) { model = 'gemini-denied'; changed = true; }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    },
  });
  assert.equal(await p.acquire(), null);
  assert.equal(p.readyCount(), 0);
  await p.refreshReadiness();
  assert.equal(p.readyCount(), 0);
  model = 'gemini-test';
  const lease = await p.acquire();
  assert.ok(lease);
  await p.release(lease);
});

test('ITP-11: unreadable durable occupancy isolates one holder and legacy duplicates add no capacity', async t => {
  const root = fixture(t);
  mkdirSync(join(root, 'data', 'agy-holder-leases'), { recursive: true });
  writeFileSync(join(root, 'data', 'agy-holder-leases', `${users[0]}.json`), '{broken');
  const p = pool(root);
  const lease = await p.acquire();
  assert.equal(lease.user, users[1]);
  await p.release(lease);
  const legacy = pool(fixture(t), { loadTokenPools: () => ({}), loadIdentities: () => [users[0], users[0]] });
  assert.equal(await legacy.refreshReadiness(), 1);
  const one = await legacy.acquire();
  assert.equal(await legacy.acquire(), null);
  await legacy.release(one);
});

test('ITP-11: terminal run records retain a live holder process on restart, including the owner', async t => {
  const root = fixture(t);
  writeReviewerRunRecord(root, { sessionUuid: 'timed-out', state: 'failed', pgid: 4242,
    subjectContext: { agyHolderLease: { identity: 'gemini-reviewer', user: owner, reviewId: 'survives-timeout' } } });
  let alive = true;
  const sessionsRead = [];
  let recoveryProbes = 0;
  const p = pool(root, { loadTokenPools: () => declarations([owner, users[1]]), loadIdentities: () => [],
    readActiveRunRecordsImpl: undefined, isPgidAliveImpl: () => alive,
    readRunRecordImpl: session => { sessionsRead.push(session); return { state: 'failed' }; },
    checkHqOwnerAuthImpl: async () => { recoveryProbes++; return { ok: true }; },
  });
  const lease = await p.acquire();
  assert.equal(lease.user, users[1]);
  await p.release(lease);
  alive = false;
  await p.refreshReadiness();
  await p.settleProbes();
  assert.deepEqual(sessionsRead, ['timed-out'], 'adoption retains the canonical run session UUID');
  assert.equal(recoveryProbes, 1, 'the failed survivor requires authenticated recovery');
  const recovered = await p.acquire();
  assert.equal(recovered.user, owner);
  await p.release(recovered);
});

for (const user of [owner, users[0]]) test(`ITP-11: failed release immediately isolates and probes ${user}`, async t => {
  const root = fixture(t);
  const probe = Promise.withResolvers();
  let probeCalls = 0;
  const p = pool(root, {
    loadIdentities: () => [user], loadTokenPools: () => declarations([user]),
    checkHqOwnerAuthImpl: async () => { probeCalls++; return probe.promise; },
    runPinnedImpl: async ({ args }) => {
      if (args[0] === 'probe') { probeCalls++; await probe.promise; return { code: 0, stdout: 'probe.ok=yes\n' }; }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    },
  });
  try {
    const lease = await p.acquire();
    await p.release(lease, { failed: true });
    assert.equal(p.readyCount(), 0);
    assert.equal(p.projection().free, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeCalls, 1, 'release starts recovery without a readiness pass');
    assert.equal(await p.acquire(), null, 'pending authentication cannot admit work');
  } finally {
    probe.resolve({ ok: true });
    await p.settleProbes();
  }
  assert.equal(p.readyCount(), 1);
  const next = await p.acquire();
  assert.ok(next);
  await p.release(next);
});

for (const user of [owner, users[0]]) test(`ITP-11: readiness retains failed probe diagnostics during cooldown for ${user}`, async t => {
  const root = fixture(t);
  let at = 1000;
  let calls = 0;
  let authenticated = false;
  const p = pool(root, {
    now: () => at, loadIdentities: () => [user], loadTokenPools: () => declarations([user]),
    checkHqOwnerAuthImpl: async () => { calls++; return { ok: authenticated, reason: 'authentication-required' }; },
    runPinnedImpl: async ({ args }) => {
      if (args[0] === 'probe') {
        calls++;
        return authenticated ? { code: 0, stdout: 'probe.ok=yes\n' }
          : { code: 1, stdout: 'probe.ok=no\nprobe.reason=authentication-required\n' };
      }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    },
  });
  const lease = await p.acquire();
  await p.release(lease, { failed: true });
  await p.settleProbes();
  const reasons = p.snapshot()[0].reasons;
  assert.match(reasons[0], /authentication-required/);
  await p.refreshReadiness();
  await p.settleProbes();
  assert.deepEqual(p.snapshot()[0].reasons, reasons, 'cheap checks preserve the authenticated failure evidence');
  assert.equal(calls, 1, 'readiness retains the durable retry deadline');
  assert.equal(p.projection().free, 0);
  authenticated = true;
  at += 60_001;
  await p.refreshReadiness();
  await p.settleProbes();
  assert.equal(calls, 2);
  assert.equal(p.readyCount(), 1);
  assert.deepEqual(p.snapshot()[0].reasons, []);
});

test('ITP-11: acquisition synchronizes a peer authentication hold and initiates recovery', async t => {
  const root = fixture(t);
  const probe = Promise.withResolvers();
  let calls = 0;
  const p = pool(root, { loadTokenPools: () => declarations([owner]), loadIdentities: () => [owner],
    checkHqOwnerAuthImpl: async () => { calls++; return probe.promise; },
  });
  await p.refreshReadiness();
  const store = createAgyHolderLeaseStore(join(root, 'data'));
  await store.update(owner, row => { row.auth = { needsProbe: true, failures: 0, retryAt: 0 }; });
  try {
    assert.equal(await p.acquire(), null);
    assert.equal(p.readyCount(), 0);
    assert.equal(p.projection().free, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    probe.resolve({ ok: true });
    await p.settleProbes();
  }
  const lease = await p.acquire();
  assert.ok(lease);
  await p.release(lease);
});

test('ITP-11: successful stale-generation probe stays fenced without authentication backoff', async t => {
  const root = fixture(t);
  const probe = Promise.withResolvers();
  let model = 'gemini-test';
  let calls = 0;
  const p = pool(root, { now: () => 1000,
    loadTokenPools: () => ({}), loadIdentities: () => [owner], resolveModel: () => model,
    checkHqOwnerAuthImpl: async () => { calls++; return calls === 1 ? probe.promise : { ok: true }; },
  });
  const lease = await p.acquire();
  await p.release(lease, { failed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  model = 'gemini-new';
  probe.resolve({ ok: true });
  await p.settleProbes();
  const store = createAgyHolderLeaseStore(join(root, 'data'));
  assert.deepEqual(store.read(owner).auth, { needsProbe: true, failures: 0, retryAt: 0 });
  assert.equal(p.readyCount(), 0);
  await p.refreshReadiness();
  await p.settleProbes();
  assert.equal(calls, 2, 'the current generation can retry without advancing the clock');
  assert.equal(store.read(owner).auth, null);
  assert.equal(p.readyCount(), 1);
});

test('ITP-11: unchanged holder updates preserve the file while false-returning mutations persist', async t => {
  const root = fixture(t);
  const store = createAgyHolderLeaseStore(join(root, 'data'));
  await store.update(owner, row => { row.auth = { needsProbe: true, failures: 0, retryAt: 0 }; });
  const path = join(root, 'data', 'agy-holder-leases', `${owner}.json`);
  const before = statSync(path, { bigint: true });
  for (const result of [null, false, undefined, true]) assert.equal(await store.update(owner, () => result), result);
  const after = statSync(path, { bigint: true });
  assert.equal(after.ino, before.ino, 'read-only refusals do not replace the atomic record');
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(await store.update(owner, row => { row.auth.failures++; return false; }), false);
  assert.equal(store.read(owner).auth.failures, 1, 'a false callback result does not discard real mutations');
});

for (const state of ['failed', 'completed', 'cancelled', 'launching']) {
  test(`ITP-11: ${state} run without a PGID ${state === 'launching' ? 'holds' : 'releases'} holder admission`, async t => {
    const root = fixture(t);
    writeReviewerRunRecord(root, { sessionUuid: 'pre-spawn', state, pgid: null,
      subjectContext: { agyHolderLease: { user: users[0], reviewId: 'pre-spawn-review' } } });
    const p = pool(root, { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]),
      readActiveRunRecordsImpl: undefined, isPgidAliveImpl: () => { throw new Error('no PGID to probe'); } });
    const lease = await p.acquire();
    assert.equal(Boolean(lease), state !== 'launching');
    await p.release(lease);
  });
}

for (const identity of [{ match: false, startedAt: '2026-10-21T00:00:00Z' },
  { match: false, gone: true, reason: 'leader exited; descendants may survive' },
  { match: false, reason: 'ps unavailable' }]) {
  test(`ITP-11: terminal PGID identity ${identity.startedAt ? 'mismatch releases' : 'uncertainty holds'} admission (${identity.reason || 'recycled PID'})`, async t => {
    const root = fixture(t);
    const record = { state: 'failed', pgid: 4242, spawnedAt: '2000-01-01T00:00:00Z',
      subjectContext: { agyHolderLease: { user: users[0], reviewId: 'historical-review' } } };
    const p = pool(root, { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]),
      readActiveRunRecordsImpl: () => [record], isPgidAliveImpl: () => true,
      verifyPgidIdentityImpl: async (pgid, spawnedAt) => {
        assert.equal(pgid, record.pgid);
        assert.equal(spawnedAt, record.spawnedAt);
        return identity;
      } });
    const lease = await p.acquire();
    assert.equal(Boolean(lease), Boolean(identity.startedAt));
    await p.release(lease);
  });
}

for (const failure of ['cleanup', 'survivor', 'unknown-processes']) {
  test(`ITP-11: ${failure} retains the durable release fence across watchers until readiness drains`, async t => {
    const root = fixture(t);
    let dirty = false;
    const options = { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]),
      listUserProcessesImpl: async () => ({ ok: !(dirty && failure === 'unknown-processes'),
        processes: dirty && failure === 'survivor' ? [{ pid: 4242, pgid: 4242, comm: 'agy' }] : [] }),
      runPinnedImpl: async ({ args }) => ({ code: dirty && failure === 'cleanup' && args[0] === 'cleanup' ? 75 : 0,
        stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n'
          : args[0] === 'probe' ? 'probe.ok=yes\n' : '' }),
    };
    const first = pool(root, options);
    const lease = await first.acquire({ reviewId: 'dirty-review' });
    dirty = true;
    await first.release(lease, { failed: true, reason: 'timeout' });
    const read = () => JSON.parse(readFileSync(join(root, 'data', 'agy-holder-leases', `${users[0]}.json`)));
    assert.equal(read().lease.generation, lease.generation);
    assert.equal(read().auth.needsProbe, true, 'failed-review auth requirement survives restart during drain');
    const other = pool(root, options);
    assert.equal(await other.acquire(), null, 'independent watcher cannot reuse a dirty slot');
    assert.equal(await first.refreshReadiness(), 0);
    assert.equal(read().lease.generation, lease.generation);
    dirty = false;
    await first.refreshReadiness();
    await first.settleProbes();
    assert.equal(read().lease, null);
    assert.equal(first.readyCount(), 1);
    await other.refreshReadiness();
    await other.settleProbes();
    const next = await other.acquire();
    assert.ok(next);
    await other.release(next);
  });
}

for (const path of ['readiness', 'acquire']) test(`ITP-11: ${path} dead-watcher reclaim cleans under lock and survives another restart`, async t => {
  const root = fixture(t);
  const options = { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]) };
  const first = pool(root, options);
  const store = createAgyHolderLeaseStore(join(root, 'data'));
  let lease;
  let dirty = true;
  let cleanupCalls = 0;
  let expectLock = true;
  const restart = () => pool(root, { ...options, isLeaseOwnerAliveImpl: () => false,
    runPinnedImpl: async ({ args }) => {
      if (args[0] === 'cleanup') {
        if (args[1] !== lease.reviewId) return { code: 0, stdout: '' };
        cleanupCalls++;
        if (expectLock) {
          assert.equal(await store.update(users[0], () => assert.fail('reclaim must hold the holder lock')), null);
          expectLock = false;
        }
        return { code: dirty ? 75 : 0, stdout: '' };
      }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    } });
  let restarted = restart();
  if (path === 'acquire') await restarted.refreshReadiness();
  lease = await first.acquire({ reviewId: 'abandoned-workspace' });
  assert.equal(await restarted.acquire(), null);
  assert.ok(cleanupCalls > 0);
  assert.equal(expectLock, false, 'reclaim cleanup verified the holder lock');
  const read = () => JSON.parse(readFileSync(join(root, 'data', 'agy-holder-leases', `${users[0]}.json`)));
  assert.equal(read().lease.generation, lease.generation);
  const beforeRestart = cleanupCalls;
  expectLock = true;
  restarted = restart();
  assert.equal(await restarted.refreshReadiness(), 0);
  assert.ok(cleanupCalls > beforeRestart, 'durable review ID preserves cleanup after another crash');
  assert.equal(expectLock, false, 'restarted reclaim cleanup verified the holder lock');
  assert.equal(read().lease.generation, lease.generation);
  dirty = false;
  await restarted.refreshReadiness();
  const replacement = await restarted.acquire();
  assert.ok(replacement);
  await first.release(lease);
  assert.equal(read().lease.generation, replacement.generation);
  await restarted.release(replacement);
});

test('ITP-11: release retains its receipt during cleanup and an already-running readiness pass', async t => {
  const root = fixture(t);
  const statusEntered = Promise.withResolvers(), finishStatus = Promise.withResolvers();
  const cleanupEntered = Promise.withResolvers(), finishCleanup = Promise.withResolvers();
  t.after(() => { finishStatus.resolve(); finishCleanup.resolve(); });
  let pause = false;
  const p = pool(root, { loadIdentities: () => [users[0]], loadTokenPools: () => declarations([users[0]]),
    runPinnedImpl: async ({ args }) => {
      if (pause && args[0] === 'status') { statusEntered.resolve(); await finishStatus.promise; }
      if (pause && args[0] === 'cleanup') { cleanupEntered.resolve(); await finishCleanup.promise; }
      return { code: 0, stdout: args[0] === 'status' ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' };
    } });
  const lease = await p.acquire({ reviewId: 'in-flight-release' });
  pause = true;
  const readiness = p.refreshReadiness();
  await statusEntered.promise;
  const releasing = p.release(lease);
  await cleanupEntered.promise;
  const read = () => JSON.parse(readFileSync(join(root, 'data', 'agy-holder-leases', `${users[0]}.json`)));
  assert.equal(p.snapshot()[0].leased, true, 'local receipt stays populated until durable release');
  assert.equal(read().lease.generation, lease.generation);
  assert.equal(await p.acquire({ reviewId: lease.reviewId }), null, 'release fences idempotent re-acquisition too');
  finishStatus.resolve();
  assert.equal(await readiness, 1, 'an already-running pass recognizes its own releasing lease');
  assert.deepEqual(p.snapshot()[0].reasons, []);
  await p.refreshReadiness();
  assert.deepEqual(p.snapshot()[0].reasons, [], 'a new pass skips the releasing holder');
  finishCleanup.resolve();
  await releasing;
  assert.equal(read().lease, null);
  assert.equal(p.snapshot()[0].leased, false);
  pause = false;
  const next = await p.acquire();
  assert.ok(next);
  await p.release(next);
});

test('ITP-11: conflicting legacy/new holder declarations hold admission', async t => {
  const p = pool(fixture(t), { loadIdentities: () => [...users].reverse() });
  assert.equal(await p.acquire(), null);
  assert.equal(p.readyCount(), 0);
});
