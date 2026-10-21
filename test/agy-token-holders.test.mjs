import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool, runWithAgyReviewerIdentity } from '../src/agy-reviewer-identities.mjs';
import { resolveGeminiCredentialConcurrencyForDispatchCandidates } from '../src/reviewer-runtime-support.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';
import { readIdentityPoolProjection } from '../src/identity-token-snapshot.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

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
  const p = pool(root, { loadTokenPools: () => declarations([owner, users[1]]), loadIdentities: () => [],
    readActiveRunRecordsImpl: undefined, isPgidAliveImpl: () => alive,
  });
  const lease = await p.acquire();
  assert.equal(lease.user, users[1]);
  await p.release(lease);
  alive = false;
  await p.refreshReadiness();
  await p.settleProbes();
  const recovered = await p.acquire();
  assert.equal(recovered.user, owner);
  await p.release(recovered);
});
