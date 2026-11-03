import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as throttleModule from '../src/rate-limit-throttle.mjs';
import { createTwoOwnerFs } from './helpers/two-owner-fs.mjs';

const {
  createRateLimitThrottle,
  GitHubBudgetDeferredError,
  readGitHubBudgetStatus,
  withGitHubBudgetScope,
} = throttleModule;

// GHSTATEOWNER-01. Two operating-system owners share the deployed
// `data/api-cache` directory (group-writable 0775). The store is written 0600,
// so it is private to the uid that wrote it. Fixture uids are arbitrary.
const OWNER_UID = 7001;
const PEER_UID = 7002;
const CREDENTIAL = 'token-000000000000000000000000';
const KEY = `${CREDENTIAL}/core`;
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };

function makeFixture(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ghstateowner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const stateDir = path.join(rootDir, 'data', 'api-cache');
  mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'rate-limit-state.json');
  const fs = createTwoOwnerFs({ directoryPath: stateDir, directoryOwnerUid: OWNER_UID });
  const throttleFor = (uid, { logger = quiet, sleepImpl = async () => {}, env = {} } = {}) => createRateLimitThrottle({
    env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath, ...env },
    nowMs: () => NOW,
    logger,
    sleepImpl,
    recordApiCallImpl: () => {},
    ...fs.forUid(uid),
  });
  return { rootDir, stateDir, statePath, fs, throttleFor };
}

function hold() {
  return { resource: 'core', credential: CREDENTIAL, remaining: 0, limit: 5000,
    resetAt: new Date(NOW + 60 * 60_000).toISOString(), observedAt: new Date(NOW).toISOString() };
}

function healthy(remaining = 4500) {
  return { resource: 'core', credential: CREDENTIAL, remaining, limit: 5000,
    resetAt: new Date(NOW + 30 * 60_000).toISOString(), observedAt: new Date(NOW).toISOString() };
}

async function freshAdmission(throttle) {
  try {
    return await withGitHubBudgetScope({}, () => throttle.awaitThrottleIfNeeded('core', CREDENTIAL));
  } catch (err) {
    if (err instanceof GitHubBudgetDeferredError) return 'deferred';
    throw err;
  }
}

test('a peer owner that cannot read the shared store never replaces it or loses its own observations', async t => {
  const { statePath, fs, throttleFor } = makeFixture(t);
  await throttleFor(OWNER_UID).recordResponseRateLimit(hold());
  assert.equal(fs.ownerOf(statePath), OWNER_UID);

  await throttleFor(PEER_UID).recordResponseRateLimit(healthy());

  // The shared store still belongs to its owner and still carries the hold.
  assert.equal(fs.ownerOf(statePath), OWNER_UID, 'peer renamed its private snapshot over the shared store');
  assert.equal(await freshAdmission(throttleFor(OWNER_UID)), 'deferred', 'owner lost its active zero-balance hold');

  // The peer's observation is private to the peer, not discarded.
  const peerStore = throttleModule.ownerScopedStatePath(statePath, PEER_UID);
  assert.equal(fs.ownerOf(peerStore), PEER_UID);
  const peer = throttleFor(PEER_UID);
  const peerView = await peer.readSharedState();
  assert.equal(peerView[KEY]?.remaining, 4500, 'peer read its own evidence as no observations');

  // The unreadable shared store is classified, not reported as empty.
  const evidence = await peer.readBudgetStoreEvidence();
  assert.equal(evidence.scope, 'owner');
  assert.equal(evidence.uid, PEER_UID);
  assert.equal(evidence.sharedOwnerUid, OWNER_UID);
  assert.equal(evidence.path, peerStore);
  assert.deepEqual(evidence.store, { path: peerStore, status: 'ok' });
  assert.deepEqual(evidence.shared, { path: statePath, status: 'unreadable', code: 'EACCES' });
  const ownerEvidence = await throttleFor(OWNER_UID).readBudgetStoreEvidence();
  assert.equal(ownerEvidence.scope, 'shared');
  assert.equal(ownerEvidence.shared, undefined);
});

test('deterministic two-owner schedules lose no hold and blind no owner', async t => {
  // Each schedule runs one owner hold and one peer healthy write in the given
  // order, then a fresh process of each owner reads. These are deterministic
  // schedules, not a production failure rate.
  const schedules = [['owner', 'peer'], ['peer', 'owner']];
  let lostHolds = 0;
  let blindPeers = 0;
  let falseSharedWrites = 0;
  for (const schedule of schedules) {
    const { statePath, fs, throttleFor } = makeFixture(t);
    for (const step of schedule) {
      if (step === 'owner') await throttleFor(OWNER_UID).recordResponseRateLimit(hold());
      else await throttleFor(PEER_UID).recordResponseRateLimit(healthy());
    }
    if (fs.ownerOf(statePath) !== OWNER_UID) falseSharedWrites += 1;
    if (await freshAdmission(throttleFor(OWNER_UID)) !== 'deferred') lostHolds += 1;
    const peerView = await throttleFor(PEER_UID).readSharedState();
    if (peerView[KEY]?.remaining !== 4500) blindPeers += 1;
  }
  assert.deepEqual({ lostHolds, blindPeers, falseSharedWrites }, { lostHolds: 0, blindPeers: 0, falseSharedWrites: 0 });
});

test('a directory owner never renames over a foreign store it cannot read', async t => {
  const { statePath, fs, throttleFor } = makeFixture(t);
  // A legacy snapshot left by a peer before this repair.
  writeFileSync(statePath, `${JSON.stringify({ version: 2, buckets: { [KEY]: healthy(17) } })}\n`, { mode: 0o600 });
  fs.setOwner(statePath, PEER_UID);
  const before = readFileSync(statePath, 'utf8');

  const owner = throttleFor(OWNER_UID);
  await owner.recordResponseRateLimit(hold());

  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(fs.ownerOf(statePath), PEER_UID);
  const ownerStore = throttleModule.ownerScopedStatePath(statePath, OWNER_UID);
  assert.equal(fs.ownerOf(ownerStore), OWNER_UID);
  assert.equal(await freshAdmission(throttleFor(OWNER_UID)), 'deferred');
  const evidence = await owner.readBudgetStoreEvidence();
  assert.equal(evidence.scope, 'owner');
  assert.equal(evidence.sharedOwnerUid, PEER_UID);
  assert.deepEqual(evidence.shared, { path: statePath, status: 'unreadable', code: 'EACCES' });
});

test('a readable shared store still contributes conservatively to a peer admission', async t => {
  const { statePath, fs, throttleFor } = makeFixture(t);
  await throttleFor(OWNER_UID).recordResponseRateLimit(hold());
  // Model a shared store the peer can read (for example, a group-readable mode).
  fs.setOwner(statePath, undefined);
  const real = fs.forUid(PEER_UID);
  const peer = createRateLimitThrottle({
    env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
    nowMs: () => NOW,
    logger: quiet,
    sleepImpl: async () => {},
    recordApiCallImpl: () => {},
    ...real,
    storeStatImpl: async target => ({ ...(await real.storeStatImpl(target)), uid: target === statePath ? OWNER_UID : (await real.storeStatImpl(target)).uid }),
  });
  await peer.recordResponseRateLimit(healthy());
  assert.equal(await freshAdmission(peer), 'deferred', 'a healthy peer observation cleared a readable shared hold');
  const evidence = await peer.readBudgetStoreEvidence();
  assert.deepEqual(evidence.shared, { path: statePath, status: 'ok' });
});

test('a peer un-scoped throttle status file stays beside its own store', async t => {
  const { statePath, throttleFor } = makeFixture(t);
  const peerStore = throttleModule.ownerScopedStatePath(statePath, PEER_UID);
  const seen = [];
  const peer = throttleFor(PEER_UID, {
    sleepImpl: async () => {
      seen.push([existsSync(`${peerStore}.throttled.json`), existsSync(`${statePath}.throttled.json`)]);
    },
  });
  await peer.recordResponseRateLimit(healthy(3));
  assert.equal(await peer.awaitThrottleIfNeeded('core', CREDENTIAL), true);
  assert.deepEqual(seen, [[true, false]]);
  assert.equal(existsSync(`${peerStore}.throttled.json`), false);
});

test('synchronous budget readers resolve the owner-scoped store and classify the shared one', async t => {
  const { statePath, fs, throttleFor } = makeFixture(t);
  await throttleFor(OWNER_UID).recordResponseRateLimit(hold());
  await throttleFor(PEER_UID).recordResponseRateLimit(healthy());
  const peerSeams = fs.forUid(PEER_UID);
  const seams = {
    getuidImpl: peerSeams.getuidImpl,
    storeStatSyncImpl: peerSeams.storeStatSyncImpl,
    readFileSyncImpl: peerSeams.readFileSyncImpl,
  };
  const env = { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath };

  const buckets = throttleModule.readGitHubBudgetBucketsSync({ env, nowMs: NOW, ...seams });
  assert.equal(buckets[KEY]?.remaining, 4500);

  const status = readGitHubBudgetStatus({ env, nowMs: NOW, ...seams });
  assert.equal(status[KEY]?.remaining, 4500);

  const store = throttleModule.readGitHubBudgetStoreStatus({ env, ...seams });
  assert.equal(store.scope, 'owner');
  assert.deepEqual(store.shared, { path: statePath, status: 'unreadable', code: 'EACCES' });
  assert.equal(store.store.status, 'ok');
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a real EACCES on the caller\'s own store is unreadable evidence, never an empty snapshot', { skip: isRoot && 'root bypasses file modes' }, async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ghstateowner-real-'));
  const statePath = path.join(rootDir, 'rate-limit-state.json');
  t.after(() => { try { chmodSync(statePath, 0o600); } catch { /* absent */ } rmSync(rootDir, { recursive: true, force: true }); });
  const make = (logger = quiet) => createRateLimitThrottle({
    env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
    nowMs: () => NOW, logger, sleepImpl: async () => {}, recordApiCallImpl: () => {},
  });
  await make().recordResponseRateLimit(hold());
  const before = readFileSync(statePath, 'utf8');
  chmodSync(statePath, 0o000);

  const warnings = [];
  const reader = make({ ...quiet, warn: message => warnings.push(String(message)) });
  assert.deepEqual(await reader.readSharedState(), {});
  await reader.readSharedState();
  const evidence = await reader.readBudgetStoreEvidence();
  assert.deepEqual(evidence.store, { path: statePath, status: 'unreadable', code: 'EACCES' });
  assert.equal(warnings.length, 1, 'one warning per process and store, no contents');
  assert.match(warnings[0], /EACCES/);
  assert.doesNotMatch(warnings[0], /token-/);

  await assert.rejects(make().recordResponseRateLimit(healthy()), err => err.code === 'GITHUB_BUDGET_STORE_UNREADABLE' && err.storeCode === 'EACCES');
  assert.equal(throttleModule.readGitHubBudgetStoreStatus({ env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath } }).store.status, 'unreadable');
  chmodSync(statePath, 0o600);
  assert.equal(readFileSync(statePath, 'utf8'), before, 'an unreadable store was replaced');
});

test('an absent store is no observations and a malformed one is classified but healed by the owner', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ghstateowner-shape-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const statePath = path.join(rootDir, 'rate-limit-state.json');
  const throttle = createRateLimitThrottle({
    env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
    nowMs: () => NOW, logger: quiet, sleepImpl: async () => {}, recordApiCallImpl: () => {},
  });
  assert.deepEqual((await throttle.readBudgetStoreEvidence()).store, { path: statePath, status: 'missing' });
  writeFileSync(statePath, '{not json', { mode: 0o600 });
  assert.deepEqual((await throttle.readBudgetStoreEvidence()).store, { path: statePath, status: 'malformed' });
  await throttle.recordResponseRateLimit(hold());
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).buckets[KEY].remaining, 0);
});

test('runtime status names an owner-scoped store and an unreadable shared store', async () => {
  const { renderRuntimeStatus } = await import('../src/runtime-status.mjs');
  const base = { mode: 'native', githubBudget: {} };
  const healthyShared = renderRuntimeStatus({ ...base, githubBudgetStore: { scope: 'shared', uid: OWNER_UID, store: { path: 'p', status: 'ok' } } });
  assert.doesNotMatch(healthyShared, /GitHub budget store/);
  const peer = renderRuntimeStatus({ ...base, githubBudgetStore: {
    scope: 'owner', uid: PEER_UID, sharedOwnerUid: OWNER_UID,
    store: { path: 'p.uid', status: 'ok' }, shared: { path: 'p', status: 'unreadable', code: 'EACCES' },
  } });
  assert.match(peer, /GitHub budget store: scope=owner store=ok shared=unreadable\(EACCES\) shared-owner-uid=7001/);
});
