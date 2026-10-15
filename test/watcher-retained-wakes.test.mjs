import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetainedWatcherWakes } from '../src/watcher-retained-wakes.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';

const identity = { repoPath: 'example/project', prNumber: 1, headSha: 'head-a' };
const logger = { log() {}, warn() {}, error() {} };

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'retained-wakes-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, store: createRetainedWatcherWakes({ rootDir }) };
}

test('capacity-deferred wake survives a restart and precedes newer wakes at one seat', async (t) => {
  const { rootDir, store } = fixture(t);
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const events = [];
  const makeCandidate = (id, wakePriority, retainedWakePriority = false) => ({
    ...id, reviewerModel: 'gemini', wakePriority, retainedWakePriority,
    subject: { headSha: id.headSha, createdAt: '2026-01-01T00:00:00Z' },
    enqueuedAtMs: nowMs,
    run: async () => { events.push(id.prNumber); store.drop(id); },
  });
  const first = makeCandidate(identity, true);
  const blocked = await runBoundedReviewerDispatchQueue([first], {
    maxConcurrent: 1, geminiCredentialConcurrency: 0, now: () => nowMs, logger,
  });
  assert.equal(blocked.deferredReasons[0].reason, 'gemini-credential-concurrency-zero');
  for (const item of blocked.deferredCandidates) if (item.wakePriority) store.retain(item);
  const restarted = createRetainedWatcherWakes({ rootDir });
  assert.equal(restarted.matches(identity), true);
  nowMs += 60_000;
  const retained = makeCandidate(identity, restarted.matches(identity), true);
  const newer = makeCandidate({ ...identity, prNumber: 2, headSha: 'head-b' }, true);
  // A fresh wake can target a much older PR's re-review too.
  newer.subject.createdAt = '2025-01-01T00:00:00Z';
  const result = await runBoundedReviewerDispatchQueue([newer, retained], {
    maxConcurrent: 1, geminiCredentialConcurrency: 1, singleWave: true,
    now: () => nowMs, logger,
  });
  assert.equal(result.dispatched, 1);
  assert.deepEqual(events, [1]);
  assert.equal(restarted.matches(identity), false);
});

test('retained wakes are scoped to repository, PR and head and are removed on head movement', (t) => {
  const { store } = fixture(t);
  store.retain(identity);
  assert.equal(store.matches({ ...identity, repoPath: 'example/other' }), false);
  assert.equal(store.matches({ ...identity, prNumber: 2 }), false);
  assert.equal(store.matches({ ...identity, headSha: 'head-b' }), false);
  store.observe({ ...identity, headSha: 'head-b' });
  assert.deepEqual(store.subjects(), []);
  store.observe(identity);
  assert.equal(store.matches(identity), false, 'moving back does not restore a spent wake');
});

test('terminal observations and authoritative closure remove retained wakes', async (t) => {
  const { store } = fixture(t);
  store.retain(identity);
  store.observe({ ...identity, terminal: true });
  assert.deepEqual(store.subjects(), []);
  for (const live of [{ state: 'closed' }, { state: 'open', mergedAt: '2026-01-01T00:00:00Z' }]) {
    store.retain(identity);
    await store.reconcileMissing({ repoPath: identity.repoPath, discoveredPrNumbers: new Set(),
      readLive: async () => live });
    assert.deepEqual(store.subjects(), []);
  }
});

test('missing discovery and failed live reads preserve priority, and reconciliation is repo-scoped', async (t) => {
  const { store } = fixture(t);
  store.retain(identity);
  for (const readLive of [async () => { throw new Error('synthetic unavailable'); },
    async () => ({ state: 'open', headRefOid: identity.headSha })]) {
    await store.reconcileMissing({ repoPath: identity.repoPath, discoveredPrNumbers: new Set(), readLive });
    assert.equal(store.matches(identity), true);
  }
  await store.reconcileMissing({ repoPath: 'example/other', discoveredPrNumbers: new Set(),
    readLive: async () => assert.fail('another repo must not be read') });
  await store.reconcileMissing({ repoPath: identity.repoPath, discoveredPrNumbers: new Set([1]),
    readLive: async () => assert.fail('discovered subjects are observed separately') });
  assert.equal(store.matches(identity), true);
});

test('a stale dispatch cannot clear priority for a newer retained head', (t) => {
  const { store } = fixture(t);
  store.retain(identity);
  const newer = { ...identity, headSha: 'head-b' };
  store.retain(newer);
  store.drop(identity);
  assert.deepEqual(store.subjects(), [newer]);
});

test('the small durable record is idempotent and malformed state adds no admission refusal', (t) => {
  const { store, rootDir } = fixture(t);
  store.retain(identity);
  store.retain(identity);
  const filePath = join(rootDir, 'data', 'watcher-wake-retained.json');
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).subjects, [identity]);
  writeFileSync(filePath, '{broken');
  assert.equal(store.matches(identity), false);
  assert.equal(store.retain(identity), true);
});
